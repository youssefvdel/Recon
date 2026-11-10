// Regression harness for the headless UI: load the dev fixture in Chromium and
// assert every destination still renders without breaking, in both the old app
// and the v2 shell.
//
//   bun run uicheck                 # old + v2 passes, default dev server
//   UICHECK_URL=http://host:port/ bun run uicheck
//   bun scripts/uicheck.ts --fail   # explicit failure semantics (same as default)
//
// It needs the dev server *and* a Chromium binary (CHROME_PATH, a Playwright
// cache, or a system chrome/chromium/brave). It is deliberately NOT part of
// `verify` yet: verify must stay server-free.
//
// Checks per route:
//   A. no view error boundary
//   B. the route's primary landmark renders
//   C. no rendered cell contains NaN / undefined / Infinity / a bare em dash
//   D. document height <= one viewport, except routes with a written allow reason
//   E. container census: elements with a radius and a border/background
//
// Exit codes: 0 all pass, 1 at least one route failed, 2 harness/setup failure.
// A failure prints the pass, route id and the exact reason.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Route = {
  id: string;
  clicks?: string[];
  marker: RegExp;
  /** Navigate to this fragment instead of the pass base (deep link). */
  hash?: string;
  /** Item to pick from the ⋯ menu (matched inside [role="menu"] only, so a page
   *  button with the same label cannot be clicked by mistake). */
  menu?: string;
  /** A Tools section whose body must have mounted (lazy mount must not be a no-op). */
  section?: string;
  /** Written reason why this route may exceed one viewport. */
  allowTall?: string;
};

type Pass = { name: 'old' | 'v2'; base: string; routes: Route[] };

const BASE = (process.env.UICHECK_URL ?? 'http://127.0.0.1:5173/').replace(/\/+$/, '') + '/';

const OLD_ROUTES: Route[] = [
  { id: 'overview', clicks: ['Tracker', 'Overview'], marker: /EPISODE|Current Act|Competitive/i, allowTall: 'the Overview feed is the page (Direction B)' },
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

/* The six tools are anchors in ONE sheet, not six pages: each route deep-links
 * to its section, and `section` asserts that section's body actually mounted —
 * a heading alone would pass even if the lazy mount never fired. */
const TOOL_ROUTES: Route[] = [
  { id: 'store', hash: '#store', section: 'store', menu: 'Store', marker: /Store/i },
  { id: 'crosshair', hash: '#crosshair', section: 'crosshair', menu: 'Crosshair', marker: /Crosshair/i },
  { id: 'prepicker', hash: '#prepick', section: 'prepick', menu: 'Pre-Picker', marker: /Pre-Picker/i },
  { id: 'resolution', hash: '#resolution', section: 'resolution', menu: 'Resolution', marker: /Resolution/i },
  { id: 'chat', hash: '#chat', section: 'chat', menu: 'Riot Chat', marker: /Riot Chat/i },
  { id: 'accounts', hash: '#accounts', section: 'accounts', menu: 'Accounts', marker: /Accounts/i },
].map((r) => ({ ...r, allowTall: 'the tools sheet is one page with six anchored sections' }));

const V2_ROUTES: Route[] = [
  { id: 'now', clicks: ['Now'], marker: /Recent matches|as of|Current Act/i, allowTall: 'the v2 feed is the page' },
  { id: 'matches', clicks: ['Matches'], marker: /Matches|Surface not built yet/i },
  { id: 'prep', clicks: ['Prep'], marker: /Prep|Surface not built yet/i },
  ...TOOL_ROUTES,
  /* Settings is its own sheet, reached from the menu — not a Tools section. */
  { id: 'settings', menu: 'Settings', marker: /Application Settings/i },
];

const PASSES: Pass[] = [
  /* The old shell is no longer the default: it is reachable only with an
   * explicit ?legacy=1, so the comparison has to ask for it by name. */
  { name: 'old', base: `${BASE}?fixture=lobby&legacy=1`, routes: OLD_ROUTES },
  { name: 'v2', base: `${BASE}?fixture=lobby`, routes: V2_ROUTES },
];

const PROBE = String.raw`(() => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const main = document.querySelector('main') || document.body;
  const text = norm(main.innerText);
  const body = norm(document.body.innerText);

  const boundary = /This view failed to load|Something went wrong/i.test(body);
  const alerts = [...document.querySelectorAll('[role="alert"]')].map((e) => norm(e.innerText)).filter(Boolean);

  const cells = [];
  for (const el of document.querySelectorAll('td, th, [role="cell"], [data-cell], [class*="stat"], [class*="value"], [class*="metric"]')) {
    const t = norm(el.innerText);
    if (!t) continue;
    if (el.querySelector('td, [role="cell"], [data-cell], [class*="stat"], [class*="value"], [class*="metric"]')) continue;
    cells.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 60), text: t });
  }
  const badCells = cells.filter((c) => /\b(?:NaN|undefined|Infinity)\b/.test(c.text) || c.text === '—' || c.text === '— —');
  const badBody = /\b(?:NaN|undefined|Infinity)\b/.test(text);

  /* A tool route deep-links to ONE section of the tools sheet. Counting the
   * whole page there would report every other section's chrome as if this route
   * carried it — the number would be about the sheet, not the surface. So the
   * census is scoped to the section the hash names; other routes are unaffected. */
  const anchor = (window.location.hash || '').replace(/^#/, '');
  const scope = anchor ? main.querySelector('[data-tools-section="' + anchor + '"]') : null;
  let cards = 0;
  for (const el of (scope ?? main).querySelectorAll('*')) {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (r.width * r.height <= 10000) continue;
    const radius = parseFloat(s.borderTopLeftRadius) || 0;
    if (radius <= 0) continue;
    const border = (parseFloat(s.borderTopWidth) || 0) > 0;
    const bg = s.backgroundColor && s.backgroundColor !== 'transparent' && s.backgroundColor !== 'rgba(0, 0, 0, 0)';
    if (!border && !bg) continue;
    const tag = el.tagName;
    // Controls are not cards: a <select> is an input control the rule already excludes.
    if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'A' || tag === 'SVG') continue;
    cards++;
  }

  return JSON.stringify({
    height: document.documentElement.scrollHeight,
    viewport: window.innerHeight,
    boundary, alerts, cards, badCells, badBody,
    mounted: [...main.querySelectorAll('[data-tools-section]')]
      .filter((e) => e.getAttribute('data-mounted') === 'true')
      .map((e) => e.id),
    placeholder: /Surface not built yet/i.test(body),
    head: text.slice(0, 180),
    /* A sheet route's landmark can sit anywhere on the page: six sections of
       real content push it past any fixed head window. Bounded, not unbounded. */
    text: text.slice(0, 6000),
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

type Result = { pass: string; route: string; ok: boolean; na: boolean; reasons: string[]; height: number; viewport: number; cards: number };

async function run(): Promise<number> {
  try {
    const res = await fetch(BASE, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
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
      for (const pass of PASSES) {
        console.log(`\n=== ${pass.name} pass ===`);
        for (const route of pass.routes) {
          const reasons: string[] = [];
          /* A different query string forces a real document load; a bare fragment
           * change is same-document and would leave the previous route mounted. */
          const url = pass.base + (route.hash ? `&u=${route.id}${route.hash}` : '');
          await cdp.send('Page.navigate', { url });
          await Bun.sleep(900);
          if (route.menu) {
            const opened = await evalx(`(() => { const n=(s)=>(s||'').replace(/\\s+/g,' ').trim(); const b=[...document.querySelectorAll('button')].find(x=>n(x.innerText)==='⋯'); if(!b) return 'NO_BUTTON'; b.click(); return 'ok'; })()`);
            if (opened !== 'ok') reasons.push(`click failed: ⋯ (${opened})`);
            await Bun.sleep(260);
            const picked = await evalx(`(() => { const n=(s)=>(s||'').replace(/\\s+/g,' ').trim(); const root=document.querySelector('[role="menu"]'); if(!root) return 'NO_MENU'; const b=[...root.querySelectorAll('button')].find(x=>n(x.innerText)===${JSON.stringify(route.menu)}); if(!b) return 'NO_ITEM'; b.click(); return 'ok'; })()`);
            if (picked !== 'ok') reasons.push(`menu item failed: ${route.menu} (${picked})`);
            await Bun.sleep(260);
          }
          for (const label of route.clicks ?? []) {
            const clicked = await evalx(`(() => { const n=(s)=>(s||'').replace(/\\s+/g,' ').trim(); const b=[...document.querySelectorAll('button')].find(x=>n(x.innerText)===${JSON.stringify(label)}); if(!b) return 'NO_BUTTON'; b.click(); return 'ok'; })()`);
            if (clicked !== 'ok') reasons.push(`click failed: ${label} (${clicked})`);
            await Bun.sleep(260);
          }
          await Bun.sleep(650);
          const data = JSON.parse(await evalx(PROBE));

          if (data.boundary) reasons.push('view error boundary is rendered');
          if (data.alerts.length) reasons.push(`role=alert: ${data.alerts.join(' | ').slice(0, 120)}`);
          const hay = route.section ? String(data.text || '') : String(data.head || '');
          if (!data.placeholder && !route.marker.test(hay)) reasons.push(`primary landmark missing (${route.marker})`);
          if (data.badBody) reasons.push('body contains NaN/undefined/Infinity');
          for (const cell of data.badCells.slice(0, 4)) reasons.push(`bad cell <${cell.tag} class="${cell.cls}">: ${JSON.stringify(cell.text).slice(0, 80)}`);
          if (route.section && !data.mounted.includes(route.section)) reasons.push(`section #${route.section} body did not mount`);
          if (data.height > data.viewport + 1 && !route.allowTall) reasons.push(`page height ${data.height} > viewport ${data.viewport}`);

          const na = Boolean(data.placeholder);
          const passOk = reasons.length === 0 && !na;
          if (!passOk && !na) failures++;
          results.push({ pass: pass.name, route: route.id, ok: passOk, na, reasons, height: data.height, viewport: data.viewport, cards: data.cards });
          console.log(
            `${na ? 'N/A ' : passOk ? 'PASS' : 'FAIL'} ${route.id}  ${data.height}/${data.viewport}px  ${data.cards} container(s)${route.allowTall ? `  (tall: ${route.allowTall})` : ''}${na ? '  (surface not built)' : ''}`
          );
          for (const r of reasons) console.log(`  - ${r}`);
        }
      }

      // Side-by-side view for the routes that exist in both passes.
      console.log('\n=== old vs v2 ===');
      for (const oldR of OLD_ROUTES) {
        const old = results.find((r) => r.pass === 'old' && r.route === oldR.id);
        const v2 = results.find((r) => r.pass === 'v2' && r.route === oldR.id);
        if (!old) continue;
        if (!v2) {
          console.log(`${oldR.id}: old ${old.height}px/${old.cards} containers · v2 n/a (not a v2 destination)`);
          continue;
        }
        console.log(`${oldR.id}: old ${old.height}px/${old.cards} containers · v2 ${v2.height}px/${v2.cards} containers${v2.na ? ' (surface not built)' : ''}`);
      }

      const total = results.filter((r) => !r.na).length;
      console.log(`\n${total - failures}/${total} checked routes pass${failures ? ` — ${failures} failed` : ''}`);
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
