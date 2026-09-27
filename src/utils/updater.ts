import { check, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { invoke } from '@tauri-apps/api/core';
import { peekLiveMatchState } from './tracker';
import { isOverlayVisible } from './ipc';

export type UpdateChannel = 'stable' | 'early-access';

export const UPDATE_CHANNEL_KEY = 'recon_update_channel_v1';

export function getUpdateChannel(): UpdateChannel {
  if (typeof localStorage === 'undefined') return 'stable';
  const val = localStorage.getItem(UPDATE_CHANNEL_KEY);
  return val === 'early-access' ? 'early-access' : 'stable';
}

export function setUpdateChannel(channel: UpdateChannel): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(UPDATE_CHANNEL_KEY, channel);
  }
}

/* Real updater pipeline.
 *
 * Replaces the old flow, which queried the GitHub API for the latest release,
 * guessed an asset by file extension, downloaded it to %TEMP% and shell-executed
 * it as an installer. That had no signature verification, no manifest, no
 * progress, no relaunch, and silently broke if the asset order changed.
 *
 * This uses Tauri's updater plugin: it fetches the signed `latest.json`
 * manifest, verifies every download against the minisign public key baked into
 * tauri.conf.json, installs quietly in place and relaunches into the new build.
 */

/** An update found and verified by the plugin. */
export interface AvailableUpdate {
  version: string;
  notes: string;
  date?: string;
  /** Opaque handle; hand back to installUpdate(). */
  handle: Update;
  channel?: UpdateChannel;
}

export type InstallEvent =
  | { phase: 'downloading'; downloaded: number; total: number }
  | { phase: 'installing' };

/** The plugin only exists inside the Tauri webview (dev browser has no updater). */
export function updaterSupported(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

interface UpdateMetadata {
  rid: number;
  currentVersion: string;
  version: string;
  date?: string;
  body?: string;
  rawJson: Record<string, unknown>;
}

/** Ask the configured channel endpoint for an update. Returns null when up to date. */
export async function checkForUpdate(channelOverride?: UpdateChannel): Promise<AvailableUpdate | null> {
  if (!updaterSupported()) return null;
  const channel = channelOverride ?? getUpdateChannel();

  try {
    const meta = await invoke<UpdateMetadata | null>('check_channel_update', { channel });
    if (!meta) return null;
    return {
      version: meta.version,
      notes: meta.body ?? '',
      date: meta.date,
      handle: new Update(meta),
      channel,
    };
  } catch {
    // Fallback: standard Tauri updater check
    const update = await check();
    if (!update) return null;
    return {
      version: update.version,
      notes: update.body ?? '',
      date: update.date,
      handle: update,
      channel: 'stable',
    };
  }
}

/** Download, verify, install quietly, and report progress. Does not relaunch. */
export async function installUpdate(
  update: AvailableUpdate,
  onEvent?: (event: InstallEvent) => void
): Promise<void> {
  let downloaded = 0;
  let total = 0;
  await update.handle.downloadAndInstall((event) => {
    switch (event.event) {
      case 'Started':
        total = event.data.contentLength ?? 0;
        onEvent?.({ phase: 'downloading', downloaded: 0, total });
        break;
      case 'Progress':
        downloaded += event.data.chunkLength ?? 0;
        onEvent?.({ phase: 'downloading', downloaded, total });
        break;
      case 'Finished':
        onEvent?.({ phase: 'installing' });
        break;
    }
  });
}

/** Download and verify the package without installing it. Pair with
 *  installDownloadedUpdate(). Kept separate from installUpdate because the
 *  Windows installer exits the app the moment install starts — downloading
 *  early is safe, installing is not. */
export async function downloadUpdate(
  update: AvailableUpdate,
  onEvent?: (event: InstallEvent) => void
): Promise<void> {
  let downloaded = 0;
  let total = 0;
  await update.handle.download((event) => {
    switch (event.event) {
      case 'Started':
        total = event.data.contentLength ?? 0;
        onEvent?.({ phase: 'downloading', downloaded: 0, total });
        break;
      case 'Progress':
        downloaded += event.data.chunkLength ?? 0;
        onEvent?.({ phase: 'downloading', downloaded, total });
        break;
      case 'Finished':
        break;
    }
  });
}

/** Install a package previously fetched with downloadUpdate(). On Windows the
 *  plugin hands off to the installer and exits this process; restartAfterInstall
 *  defaults true, so the installer brings the new build back up. */
export async function installDownloadedUpdate(update: AvailableUpdate): Promise<void> {
  await update.handle.install();
}

/** Relaunch into the freshly installed build. */
export async function restartApp(): Promise<void> {
  await relaunch();
}

/* ---- Install safety: never install over a live match or a visible overlay ---- */

/** Human-readable reason an install is blocked right now, or null when safe.
 *  Reads the freshest live state the app has (in-memory poll result first,
 *  else the persisted cache, which applies LIVE_MATCH_CACHE_TTL_MS). */
export async function getInstallBlocker(): Promise<string | null> {
  const live = peekLiveMatchState();
  if (live && !live.isPreviousMatch && live.phase !== 'idle') {
    return 'A match is live — finish the match or close the overlay to update.';
  }
  try {
    if (await isOverlayVisible()) {
      return 'The in-game overlay is up — close it to update.';
    }
  } catch {
    // Cannot read the overlay state → do not gamble on an install that exits the app.
    return 'Could not verify the match/overlay state — try again in a moment.';
  }
  return null;
}

/** Single shared guard for every install path (auto and manual). */
export async function isSafeToInstallUpdate(): Promise<boolean> {
  return (await getInstallBlocker()) === null;
}

/* ---- Background auto-update: check once, download, hold for the safe moment ---- */

export type AutoUpdatePhase = 'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'error';

export interface AutoUpdateState {
  phase: AutoUpdatePhase;
  update: AvailableUpdate | null;
  downloaded: number;
  total: number;
  error: string | null;
  /** Current predicate result; refreshed while an update sits ready. */
  safeToInstall: boolean;
  /** User chose "Later" — the prompt stays away until the next launch. */
  deferred: boolean;
}

/** Safety re-check cadence while an update sits ready: 10s is a localStorage
 *  read plus one cheap IPC, so a prompt lags the overlay closing by at most one
 *  tick, and every install click re-checks the guard anyway. */
export const SAFE_INSTALL_POLL_MS = 10_000;

let autoState: AutoUpdateState = {
  phase: 'idle',
  update: null,
  downloaded: 0,
  total: 0,
  error: null,
  safeToInstall: false,
  deferred: false,
};

const autoListeners = new Set<(state: AutoUpdateState) => void>();
let safetyTimer: ReturnType<typeof setInterval> | null = null;
let autoStarted = false;

function publishAutoState(patch: Partial<AutoUpdateState>): void {
  autoState = { ...autoState, ...patch };
  for (const listener of autoListeners) listener(autoState);
}

export function getAutoUpdateState(): AutoUpdateState {
  return autoState;
}

export function subscribeAutoUpdate(listener: (state: AutoUpdateState) => void): () => void {
  autoListeners.add(listener);
  return () => {
    autoListeners.delete(listener);
  };
}

async function refreshInstallSafety(): Promise<void> {
  const safe = await isSafeToInstallUpdate();
  if (autoState.safeToInstall !== safe) publishAutoState({ safeToInstall: safe });
}

function startSafetyPoll(): void {
  if (safetyTimer) return;
  void refreshInstallSafety();
  safetyTimer = setInterval(() => {
    void refreshInstallSafety();
  }, SAFE_INSTALL_POLL_MS);
}

function stopSafetyPoll(): void {
  if (safetyTimer) {
    clearInterval(safetyTimer);
    safetyTimer = null;
  }
}

/** Check once per launch, download once, then hold. Idempotent: re-entry while
 *  a check/download is in flight or an update is already ready is a no-op.
 *  A failed download is not retried — Settings shows the error quietly. */
export async function startAutoUpdate(): Promise<void> {
  if (autoStarted) return;
  autoStarted = true;
  publishAutoState({ phase: 'checking', error: null });

  let found: AvailableUpdate | null = null;
  try {
    found = await checkForUpdate();
  } catch (e) {
    publishAutoState({ phase: 'error', error: String(e) });
    return;
  }
  if (!found) {
    publishAutoState({ phase: 'idle', update: null, downloaded: 0, total: 0 });
    return;
  }

  publishAutoState({ phase: 'downloading', update: found, downloaded: 0, total: 0, error: null });
  try {
    await downloadUpdate(found, (event) => {
      if (event.phase === 'downloading') {
        publishAutoState({ downloaded: event.downloaded, total: event.total });
      }
    });
    // Downloaded + signature-verified. Installing would exit the app, so hold.
    publishAutoState({ phase: 'ready', safeToInstall: false });
    startSafetyPoll();
  } catch (e) {
    publishAutoState({ phase: 'error', error: String(e) });
  }
}

/** Install the downloaded update. The caller must have confirmed with the user
 *  and checked the guard — re-checks nothing here, on Windows this exits. */
export async function installAutoUpdate(): Promise<void> {
  if (autoState.phase !== 'ready' || !autoState.update) return;
  const update = autoState.update;
  stopSafetyPoll();
  publishAutoState({ phase: 'installing' });
  try {
    await installDownloadedUpdate(update);
    // Unreachable on Windows (the plugin exits after launching the installer).
    await restartApp();
  } catch (e) {
    publishAutoState({ phase: 'ready', error: String(e) });
    throw e;
  }
}

/** User chose "Later": stop the safety poll and never nag again this launch.
 *  The update stays ready in Settings. */
export function deferAutoInstall(): void {
  stopSafetyPoll();
  publishAutoState({ deferred: true });
}
