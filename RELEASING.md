# Releasing Recon

The in-app updater is **not** a GitHub download link. It uses Tauri's signed
updater: the app fetches `latest.json` from the newest GitHub release, downloads
the payload, verifies it against the **minisign public key** in
`src-tauri/tauri.conf.json`, installs quietly in place, and relaunches itself.

**If the signature does not verify, the update is refused.** That is the point.

---

## One-time setup (already done on this machine)

A signing keypair was generated with `tauri signer generate`:

| File | Where | Secret? |
| --- | --- | --- |
| `recon.key` — private, signs every release | `%LOCALAPPDATA%\Recon\signing\recon.key` | **YES — never commit, never share, never lose** |
| `recon.key.pub` — public, ships in the app | copy is inlined in `tauri.conf.json` → `plugins.updater.pubkey` | safe to publish |

> ⚠️ **Back the private key up somewhere safe.** If it is lost, no future release
> can be signed and every installed app will refuse updates — the fix would be a
> manual reinstall for every user.

---

## Cutting a release

### 1. Bump the version

```bash
bun run bump -- 0.4.0
```

The bump script writes **both** `package.json` and `src-tauri/Cargo.toml`. They must
match:

- `Cargo.toml` → `env!("CARGO_PKG_VERSION")` is what the app reports as *current*.
- `package.json` → the bundled app version (`tauri.conf.json` sets `"version": "../package.json"`).

If they drift, the updater compares against the wrong "current" version and either
never offers an update or offers one forever.

### 2. Build, signed

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$LOCALAPPDATA/Recon/signing/recon.key")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""   # key was generated without one
bun run tauri build
```

> Windows gotcha (hit 2026-09-15): the key is encrypted with an EMPTY password,
> and empty env vars cannot survive PowerShell/.NET (`$env:X = ''` deletes the
> var), so the build stalls at "Decrypting updater signing key, expect a prompt
> for password". Run the build from MSYS bash (e.g. Hermes-bundled Git), where
> `export ...=""` produces a real empty value that reaches Tauri. `python` is
> not installed on this box, so `make-latest-json.sh` fails — use the Node
> equivalent (same manifest shape) instead.

> Pass the key **contents**. `TAURI_SIGNING_PRIVATE_KEY_PATH` was tried first and did
> not take effect — the build proceeded unsigned and only warned at the very end.

Outputs under `src-tauri/target/release/bundle/`:

| Artifact | Purpose |
| --- | --- |
| `nsis/Recon_<v>_x64-setup.exe` | manual installer **and the updater payload** |
| `nsis/Recon_<v>_x64-setup.exe.sig` | **its signature — without this, updates are refused** |
| `msi/Recon_<v>_x64_en-US.msi` | enterprise install |
| `msi/Recon_<v>_x64_en-US.msi.sig` | its signature |

> Tauri v2 signs the NSIS `-setup.exe` directly. There is no `.nsis.zip` wrapper —
> don't go looking for one.

**Missing `.sig` files mean the build was not signed. Do not publish it.** The build
still "succeeds" and produces installers; signing failure shows up only as:

```
A public key has been found, but no private key.
Make sure to set `TAURI_SIGNING_PRIVATE_KEY` environment variable.
```

Use `TAURI_SIGNING_PRIVATE_KEY` (the key **contents**). The `..._PATH` variant did not
take effect on this setup. Confirm the `.sig` files exist before going further.

### 3. Generate `latest.json`

The updater endpoint is
`https://github.com/youssefvdel/Recon/releases/latest/download/latest.json`, so this
file must be attached to the release. Tauri does not create it outside CI, so there is
a script:

```bash
bash scripts/make-latest-json.sh 0.4.0 /tmp/recon_release_notes.md
```

It reads the `.sig` next to the setup exe and writes the manifest
(`version`, `notes`, `pub_date`, and `platforms["windows-x86_64"]{signature,url}`)
to `$TMPDIR/latest.json`. The signature must be the file **contents**, never a path.

### 4. Publish the release

```bash
V=0.4.0
B=src-tauri/target/release/bundle
gh release create "v${V}" \
  "$B/nsis/Recon_${V}_x64-setup.exe" \
  "$B/nsis/Recon_${V}_x64-setup.exe.sig" \
  "$B/msi/Recon_${V}_x64_en-US.msi" \
  "$B/msi/Recon_${V}_x64_en-US.msi.sig" \
  "$TMPDIR/latest.json" \
  --title "Recon v${V}" --notes-file notes.md --latest
```

Three assets go up: the setup exe, its `.sig`, and `latest.json` (bundle targets
are nsis-only, so there is no MSI).

Two rules:

- **Do not mark it a prerelease or draft.** `/releases/latest` skips both, so the
  updater would never see it.
- The tag must be higher than the running build (`v0.4.0` > `0.3.0`).

### 5. Verify before telling anyone

```bash
# 1. the release is the newest and not excluded
gh release view "v0.4.0" --json tagName,isDraft,isPrerelease,assets \
  --jq '{tag:.tagName, draft:.isDraft, pre:.isPrerelease, assets:[.assets[].name]}'

# 2. the exact endpoint the app polls resolves
curl -sL -o /tmp/v.json -w "%{http_code}\n" \
  https://github.com/youssefvdel/Recon/releases/latest/download/latest.json

# 3. the manifest points at a real download
python -c "import json;m=json.load(open('/tmp/v.json'));print(m['version']);print(m['platforms']['windows-x86_64']['url'])"
```

Then install an **older** build and use **Settings → Check for updates**: it should
offer the new version, download with a progress bar, and restart itself. A build can
only update itself if it already contains the plugin — 0.3.0 was the first.

---

## Releases from CI (one command)

CI is the normal path now; the manual steps above stay for offline recovery.

```bash
git tag v0.5.0-alpha && git push origin v0.5.0-alpha
# or re-run an existing tag without a new push:
gh workflow run release.yml --ref v0.5.0-alpha
```

`.github/workflows/release.yml` builds the NSIS bundle with updater artifacts,
signs it with `TAURI_SIGNING_PRIVATE_KEY`, generates `latest.json`, and publishes
a GitHub Release with `Recon_<v>_x64-setup.exe`, its `.sig`, and `latest.json`.
The run refuses to start unless the tag is `v*` and matches the `package.json`
version — `bun run bump` keeps those in sync.

### When signing fails

The run goes red before publishing anything. In the "Build signed bundle" log:

```
A public key has been found, but no private key.
Make sure to set `TAURI_SIGNING_PRIVATE_KEY` environment variable.
```

means the key secret is missing. A stall at

```
Decrypting updater signing key, expect a prompt for password
```

means the password env did not reach Tauri (an empty password is fine, a missing
variable is not). The generator is the last line of defence: it refuses to write
the manifest with

```
missing signature ... — was the build signed?
```

If a release page has the exe but no `.sig`, do not announce it: installed apps
refuse the update.

---

## Fixed WebView2 runtime

Recon ships Microsoft's WebView2 fixed-version runtime; it does not depend on the
machine's. `bundle.windows.webviewInstallMode` is `fixedRuntime` at
`webview2-runtime`, and at startup Tauri sets
`WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` to `<recon.exe folder>\webview2-runtime`.
There is **no fallback**: a missing or incomplete folder opens zero windows — not
an error dialog.

- Pinned: **157.0.4341.42**, Microsoft's official fixed-version `.cab` (WebView2
  download page), 257 files / 678 MB unpacked; `msedge.dll` alone is 357 MB.
- Fetch: `bun scripts/fetch-webview2.mjs`. CI runs it before every build and
  fails unless `msedge.dll` and the rest of the required set are present and
  Microsoft-signed. `src-tauri/webview2-runtime/` is gitignored — never commit it.
- Packaging: tauri-bundler 2.10.4 has **no NSIS arm for fixedRuntime** and never
  copies the folder. It is shipped through
  `bundle.resources: ["webview2-runtime/"]`, which installs it to
  `$INSTDIR\webview2-runtime`. Keep both halves: the config alone ships no
  runtime; the resources entry alone does not make Tauri look there.

The layout is always `Recon/recon.exe` plus `Recon/webview2-runtime/` (no
nesting), for the installer and for `recon-portable-windows-x64.zip` alike.
**Never hand out a bare `recon.exe`** — a "replace the exe" download is broken by
design now.

To bump the runtime: change `VERSION` in `scripts/fetch-webview2.mjs`, run
`bun scripts/fetch-webview2.mjs`, build once, and commit only the script change.
A wrong or unsigned payload fails the fetch step, so it cannot reach a release.

### Updating between WebView2 modes

An installed copy must match the release's WebView2 mode. The alpha6 → alpha7
jump changed the layout (the `webview2-runtime/` folder appeared), so a
system-mode install cannot serve a fixed-runtime build and vice versa. The
symptom is a process that starts but never shows a window. Fix by uninstalling
the old copy and installing the new release — never by replacing `recon.exe` by
hand or mixing artifacts from two modes. Windows 10 additionally needs
AppContainer read/execute grants on the folder; see `docs/webview2-embedded.md`.

The installer remembers its directory as the default value of
`HKCU\Software\Youssef Adel\Recon`. Uninstalling now clears that value (and the
parent keys when they are empty), and an install ignores a remembered directory
that does not contain `recon.exe` (the directory is created before the hook
runs, so an emptiness check is not reliable), so a stale probe install can no
longer redirect a later one.

### Release timing (measured 2026-11-09, alpha9)

| Step | Time |
| --- | --- |
| Fetch WebView2 runtime (310 MB download + extract) | 9 s |
| Build signed bundle (Rust release + NSIS over 679 MB) | 833 s |
| Sign, `latest.json`, publish | 19 s |
| Whole release job | ~14.5 min |

The CAB is cached between runs: `actions/cache` keeps `.webview2-cache/*.cab`,
keyed by the hash of `scripts/fetch-webview2.mjs`, and the script's pinned
sha256 rejects a stale or corrupt entry (it re-downloads instead). A warm cache
turns the fetch step into extraction only (5 s measured locally vs 9 s cold on
CI), so the 310 MB download disappears but the release is still dominated by
`Build signed bundle`. The updater needs no timeout change for the 253 MB
installer: its plugin builder defaults to no request timeout; the only 4 s cap
in the app is the early-access releases-API probe, not the payload.

---

## Code signing

`recon.exe` downloads are Authenticode-signed in CI with a **self-signed**
certificate (`CN=Youssef Adel,O=Recon,C=EG`, RSA 4096, SHA-256, 5 years from
2026-11-07) and timestamped by DigiCert. The **"Sign recon.exe"** step in
`.github/workflows/build-windows.yml` does it. When the secrets are absent (forks,
runs without them) the step skips and the exe is unsigned.

| Secret | Holds |
| --- | --- |
| `WINDOWS_SIGN_PFX_B64` | the PFX, base64-encoded |
| `WINDOWS_SIGN_PFX_PASSWORD` | its password |

Rules:

- **Never commit the PFX or its password.** They live in repo secrets only.
- **Rotate the certificate and the two secrets together.** A new cert with a stale
  secret makes the signing step fail — loudly, before upload, which is intended.
- Signing only removes the warning on machines that install the public cert; it is
  not SmartScreen reputation. Creation, rotation, user install, the paid OV/EV path
  and local signing are in [docs/release-signing.md](docs/release-signing.md).

---

## Why the app can't just replace its own .exe

Windows will not let a running process overwrite its own executable, and Recon
keeps a WebView2 runtime and an overlay window alive. Every serious Windows app
therefore hands off to a signed installer or an updater helper; the "silent
in-place" experience is the installer running with `/S` and no UI while the app
exits and relaunches. That is what the plugin does here — the difference from the
old flow is verification, a real manifest, progress and an automatic restart.

## Legacy

The old GitHub-API flow (`check_app_updates` / `install_app_update`) has been
removed: it guessed an asset by file extension, downloaded it to `%TEMP%` and
shell-executed it, with no signature check. `plugin-updater` is the only update
path now.
