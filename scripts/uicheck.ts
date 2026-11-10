// Regression harness for the headless UI: load the dev fixture in Chromium and
// assert every destination still renders without breaking.
//
//   bun run uicheck                # default http://127.0.0.1:5173/
//   UICHECK_URL=http://host:port/ bun run uicheck
//
// It needs the dev server *and* a Chromium binary (CHROME_PATH, a Playwright
// cache, or a system chrome/chromium/brave). It is deliberately NOT part of
// `verify` yet: verify must stay server-free.
//
// Checks per route:
//   A. no view error boundary
//   B. the route's primary landmark renders
//   C. no rendered cell contains NaN / undefined / Infinity / a bare em dash
//   D. document height <= one viewport, except routes the design allows to scroll
//
// Exit codes: 0 all pass, 1 at least one route failed, 2 harness/setup failure.
// A failure prints the route id and the exact reason.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Route = {
  id: string;
  /** Labels to click after load, in order. Overview/Matches/Prep share a tab strip. */
  clicks?: string[];
  /** Text that must appear in the rendered main area (the primary landmark). */
  marker: RegExp;
  /** The design allows this route to exceed one viewport (the redesign target). */
  allowTall?: string;
};

const BASE = process.env.UICHECK_URL ?? 'http://127.0.0.1:5173/';

const ROUTES: Route[] = [
  { id: 'overview', clicks: ['Tracker', 'Overview'], marker: /EPISODE|Current Act|Competitive/i },
  { id: 'matches', clicks: ['Tracker', 'Matches'], marker: /Match History/i },
  { id: 'prep', clicks: ['Tracker', 'Prep'], marker: /AGENTS ·|Agent Time/i },
  { id: 'store', clicks: ['Store'], marker: /STORE/i },
  { id: 'crosshair', clicks: ['Crosshair'], marker: /CROSSHAIR/i },
  { id: 'resolution', clicks: ['Resolution Switch'], marker: /Stretch Preview|Native 16:9/i },
  { id: 'chat', clicks: ['Riot Chat'], marker: /Friends|Requests|Blocked/i },
  { id: 'prepicker', clicks: ['Pre-Picker'], marker: /AUTO-HOVER|Map-Specific Agent Lineup/i },
  { id: 'accounts', clicks: ['Accounts'], marker: /ACCOUNTS|No saved logins|Live account/i },
  { id: 'settings', clicks: ['Settings'], marker: /Application Settings/i },
];

// The feed is the page: natural page scroll is the Direction B design.
ROUTES[0].allowTall = 'the Overview feed is the page';
const UNIQUE_ROUTES = ROUTES;

const PROBE = String.raw`(() => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const main = document.querySelector('main') || document.body;
  const text = norm(main.innerText);
  const body = norm(document.body.innerText);

  const boundary = /This view failed to load|Something went wrong|view failed to load/i.test(body);
  const alerts = [...document.querySelectorAll('[role="alert"]')].map((e) => norm(e.innerText)).filter(Boolean);

  const cells = [];
  for (const el of document.querySelectorAll('td, th, [role="cell"], [data-cell], [class*="stat"], [class*="value"], [class*="metric"]')) {
    const t = norm(el.innerText);
    if (!t) continue;
    // only leaf-ish cells; parents would repeat their children's text
    if (el.querySelector('td, [role="cell"], [data-cell], [class*="stat"], [class*="value"], [class*="metric"]')) continue;
    cells.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 60), text: t });
  }
  const badCells = cells.filter((c) =>
    /\b(?:NaN|undefined|Infinity)\b/.test(c.text) || c.text === '—' || c.text === '— —'
  );
  const badBody = /\b(?:NaN|undefined|Infinity)\b/.test(text);

  return JSON.stringify({
    height: document.documentElement.scrollHeight,
    viewport: window.innerHeight,
    boundary,
    alerts,
    markerHit: false, // set by the caller against the route marker
    badCells,
    badBody,
    head: text.slice(0, 160),
  });
})()`;

type Cdp = { send: (method: string, params?: Record<string, unknown>) => Promise<any>; close: () => void };

function findChrome(): string {
  const candidates: string[] = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  const cache = join(process.env.HOME ?? '/root', '.cache/ms-playwright');
  for (const v of ['chromium-1254', 'chromium-1248', 'chromium_headless_shell-1254', 'chromium_headless_shell-1248']) {
    for (const bin of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-linux/headless_shell']) {
      candidates.push(join(cache, v, bin));
    }
  }
  candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/brave-browser');
  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    console.error('uicheck: no Chromium found — set CHROME_PATH to a chrome/chromium binary.');
    process.exit(2);
  }
  return found;
}

function connect(url: string): Promise<Cdp> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    let id = 0;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
    sock.onerror = (e) => reject(e);
    sock.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      }
    };
    sock.onopen = () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const n = ++id;
            pending.set(n, { resolve: res, reject: rej });
            sock.send(JSON.stringify({ id: n, method, params }));
          }),
        close: () => sock.close(),
      });
  });
}

async function waitForDevtools(profile: string, timeoutMs = 15000): Promise<number> {
  const file = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const port = Number(readFileSync(file, 'utf8').split('\n')[0]);
      if (port > 0) return port;
    }
    await Bun.sleep(100);
  }
  throw new Error('chromium did not expose a DevTools port');
}

type Result = { route: string; pass: boolean; reasons: string[]; height: number; viewport: number };

async function run(): Promise<number> {
  // The dev server must be up; this check is intentionally not part of verify.
  try {
    const res = await fetch(BASE, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(`uicheck: dev server not reachable at ${BASE} — run "bun run dev:ui" first.`);
    return 2;
  }

  const chrome = findChrome();
  const profile = mkdtempSync(join(tmpdir(), 'uicheck-'));
  const proc = Bun.spawn(
    [chrome, '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--window-size=1440,900', 'about:blank'],
    { stdout: 'ignore', stderr: 'ignore' },
  );

  let failures = 0;
  try {
    const port = await waitForDevtools(profile);
    const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(BASE)}`, { method: 'PUT' }).then((r) => r.json());
    const cdp = await connect(created.webSocketDebuggerUrl);
    try {
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      const evalx = async (expression: string) => {
        const out = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (out.exceptionDetails) throw new Error(JSON.stringify(out.exceptionDetails).slice(0, 300));
        return out.result?.value;
      };

      const results: Result[] = [];
      for (const route of UNIQUE_ROUTES) {
        const reasons: string[] = [];
        await cdp.send('Page.navigate', { url: `${BASE}?fixture=lobby` });
        await Bun.sleep(900);
        for (const label of route.clicks ?? []) {
          const clicked = await evalx(`(() => { const n=(s)=>(s||'').replace(/\\s+/g,' ').trim(); const b=[...document.querySelectorAll('button')].find(x=>n(x.innerText)===${JSON.stringify(label)}); if(!b) return 'NO_BUTTON'; b.click(); return 'ok'; })()`);
          if (clicked !== 'ok') reasons.push(`click failed: ${label} (${clicked})`);
          await Bun.sleep(260);
        }
        await Bun.sleep(650);
        const data = JSON.parse(await evalx(PROBE));

        if (data.boundary) reasons.push('view error boundary is rendered');
        if (data.alerts.length) reasons.push(`role=alert: ${data.alerts.join(' | ').slice(0, 120)}`);
        const rendered = String(data.head || '');
        if (!route.marker.test(rendered)) reasons.push(`primary landmark missing (${route.marker})`);
        if (data.badBody) reasons.push('body contains NaN/undefined/Infinity');
        for (const cell of data.badCells.slice(0, 4)) {
          reasons.push(`bad cell <${cell.tag} class="${cell.cls}">: ${JSON.stringify(cell.text).slice(0, 80)}`);
        }
        if (data.height > data.viewport + 1 && !route.allowTall) {
          reasons.push(`page height ${data.height} > viewport ${data.viewport}`);
        }

        const pass = reasons.length === 0;
        if (!pass) failures++;
        results.push({ route: route.id, pass, reasons, height: data.height, viewport: data.viewport });
        console.log(`${pass ? 'PASS' : 'FAIL'} ${route.id}  ${data.height}/${data.viewport}px${route.allowTall ? `  (allowed: ${route.allowTall})` : ''}`);
        for (const r of reasons) console.log(`  - ${r}`);
      }

      console.log(`\n${UNIQUE_ROUTES.length - failures}/${UNIQUE_ROUTES.length} routes pass${failures ? ` — ${failures} failed` : ''}`);
    } finally {
      cdp.close();
      await fetch(`http://127.0.0.1:${port}/json/close/${created.id}`).catch(() => {});
    }
  } catch (err) {
    console.error('uicheck:', err instanceof Error ? err.message : err);
    return 2;
  } finally {
    proc.kill();
    rmSync(profile, { recursive: true, force: true });
  }
  return failures > 0 ? 1 : 0;
}

process.exit(await run());
