// Measures text contrast on a rendered page through the DOM — what ships, not
// what the CSS says. Written for the v2 theme boards (2026-11-10); it is also
// the check for the real app once the shell exists.
//
//   bun scripts/theme-contrast.ts http://127.0.0.1:8110/board-a.html
//   bun scripts/theme-contrast.ts <url...> --fail        # exit 1 on a failure
//   bun scripts/theme-contrast.ts <url...> --json        # machine-readable
//   bun scripts/theme-contrast.ts <url...> --wait 8000   # max readiness wait (ms)
//
// A dev server compiles routes on first hit, so the page is measured only once
// its text has stopped changing — not 600ms after the load event.
//
// Thresholds: WCAG 2.1 — normal text 4.5:1, large text (>=24px, or >=18.66px at
// weight >=700) 3:1, UI glyphs (a lone ›/∅/…) 3:1. Decorative marks (a
// `.stamp`/`.watermark`, aria-hidden) are reported but do not fail the run.
//
// Needs a Chromium binary: $CHROME_PATH, a Playwright cache, or a system
// chromium/brave. Nothing else — no dependencies.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Row = {
  sel: string;
  text: string;
  color: string;
  size: number;
  weight: number;
  bg: string;
  ratio: number;
  large: boolean;
  glyph: boolean;
  decorative: boolean;
  need: number;
  pass: boolean;
};

type PageResult = {
  title: string;
  bodyBg: string;
  rows: Row[];
  focusables: number;
  focusRules: number;
  focusRing: { sel: string; outline: string; ratio: number; visible: boolean }[];
  fontSizes: Record<string, number>;
};

const PROBE = String.raw`(() => {
  function parse(c) {
    if (!c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)') return null;
    const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null;
    const p = m[1].split(',').map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function lin(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  function lum(c) { return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b); }
  function ratio(a, b) { const L1 = lum(a), L2 = lum(b); const hi = Math.max(L1, L2), lo = Math.min(L1, L2); return (hi + 0.05) / (lo + 0.05); }
  function composite(fg, bg) { const a = fg.a; return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 }; }
  function effectiveBg(el) {
    const layers = []; let cur = el;
    while (cur) { const c = parse(getComputedStyle(cur).backgroundColor); if (c && c.a > 0) layers.push(c); cur = cur.parentElement; }
    let out = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) out = composite(layers[i], out);
    return out;
  }
  function rgb(c) { return 'rgb(' + Math.round(c.r) + ', ' + Math.round(c.g) + ', ' + Math.round(c.b) + ')'; }
  function sel(el) {
    let s = el.tagName.toLowerCase();
    const cls = typeof el.className === 'string' ? el.className.trim() : '';
    if (cls) s += '.' + cls.split(/\s+/).slice(0, 2).join('.');
    return s;
  }
  function decorative(el) {
    for (let cur = el; cur; cur = cur.parentElement) {
      const cs = getComputedStyle(cur);
      if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return true;
      const cls = typeof cur.className === 'string' ? cur.className : '';
      if (/(stamp|watermark|decor)/i.test(cls) || (cur.dataset && cur.dataset.decorative === 'true')) return true;
      if (cs.display === 'none' || cs.visibility === 'hidden') return true;
    }
    return false;
  }
  const rows = [];
  for (const el of document.querySelectorAll('body *')) {
    const hasText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 0);
    if (!hasText) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue;
    /* WCAG 1.4.3 exempts inactive components: a disabled button is allowed to be
     * dim. Flagging it produces a failure nobody can act on without destroying
     * the affordance, so it is skipped rather than reported. */
    if (el.closest('[disabled], [aria-disabled="true"]')) continue;
    const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue;
    const fg = parse(cs.color); if (!fg) continue;
    const bg = effectiveBg(el);
    const onBg = fg.a < 1 ? composite(fg, bg) : fg;
    const text = el.textContent.trim().replace(/\s+/g, ' ');
    const size = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const glyph = text.length <= 2 && !/[A-Za-z0-9]/.test(text);
    const need = glyph || large ? 3 : 4.5;
    const cr = +ratio(onBg, bg).toFixed(2);
    rows.push({ sel: sel(el), text: text.slice(0, 46), color: rgb(onBg), size, weight, bg: rgb(bg), ratio: cr, large, glyph, decorative: decorative(el), need, pass: cr >= need });
  }
  const focusables = [...document.querySelectorAll('a,button,input,select,textarea,[tabindex]')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  let focusRules = 0;
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of rules) if (rule.cssText && /:focus/.test(rule.cssText)) focusRules++;
  }
  const bodyBg = parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
  const focusRing = [];
  for (const el of focusables.slice(0, 4)) {
    el.focus();
    const cs = getComputedStyle(el);
    const outline = parse(cs.outlineColor) || bodyBg;
    const r2 = ratio(outline, bodyBg);
    focusRing.push({ sel: sel(el), outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor, ratio: +r2.toFixed(2), visible: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 && r2 >= 3 });
  }
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  const fontSizes = {};
  for (const r of rows) fontSizes[String(r.size)] = (fontSizes[String(r.size)] || 0) + 1;
  return JSON.stringify({ title: document.title, bodyBg: rgb(bodyBg), rows, focusables: focusables.length, focusRules, focusRing, fontSizes });
})()`;

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
    console.error('theme-contrast: no Chromium found — set CHROME_PATH to a chrome/chromium binary.');
    process.exit(2);
  }
  return found;
}

type Cdp = { send: (method: string, params?: Record<string, unknown>) => Promise<any>; close: () => void };

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

async function measurePage(port: number, url: string): Promise<PageResult> {
  const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).then((r) => r.json());
  const cdp = await connect(created.webSocketDebuggerUrl);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    // Ready when the rendered text stops growing. Vite dev compiles on demand,
    // so a fixed sleep measures the old frame (or an empty one) and lies.
    let last = -1;
    let stable = 0;
    const deadline = Date.now() + maxWait;
    while (Date.now() < deadline) {
      await Bun.sleep(250);
      const probe = await cdp.send('Runtime.evaluate', { expression: 'document.body.innerText.length', returnByValue: true });
      const len = Number(probe.result?.value ?? 0);
      stable = len > 0 && len === last ? stable + 1 : 0;
      last = len;
      if (stable >= 2) break;
    }
    await Bun.sleep(200);
    const out = await cdp.send('Runtime.evaluate', { expression: PROBE, returnByValue: true, awaitPromise: true });
    if (out.exceptionDetails) throw new Error(JSON.stringify(out.exceptionDetails).slice(0, 300));
    return JSON.parse(out.result.value) as PageResult;
  } finally {
    cdp.close();
    await fetch(`http://127.0.0.1:${port}/json/close/${created.id}`).catch(() => {});
  }
}

const args = process.argv.slice(2);
const urls = args.filter((a) => /^https?:\/\//.test(a));
const failMode = args.includes('--fail');
const jsonMode = args.includes('--json');
const waitIdx = args.indexOf('--wait');
const maxWait = waitIdx >= 0 ? Number(args[waitIdx + 1]) || 10000 : 10000;
if (urls.length === 0) {
  console.error('usage: bun scripts/theme-contrast.ts <url...> [--fail] [--json]');
  process.exit(2);
}

const chrome = findChrome();
const profile = mkdtempSync(join(tmpdir(), 'theme-contrast-'));
const proc = Bun.spawn(
  [chrome, '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-sandbox', '--disable-gpu', '--hide-scrollbars', 'about:blank'],
  { stdout: 'ignore', stderr: 'ignore' },
);

let failures = 0;
try {
  const port = await waitForDevtools(profile);
  const results: Record<string, PageResult> = {};
  for (const url of urls) results[url] = await measurePage(port, url);

  if (jsonMode) {
    console.log(JSON.stringify({ generated: new Date().toISOString(), chrome, results }, null, 1));
  } else {
    for (const [url, r] of Object.entries(results)) {
      const bad = r.rows.filter((x) => !x.pass && !x.decorative);
      failures += bad.length;
      console.log(`\n${url.replace(/^https?:\/\/[^/]+/, '')}  —  ${r.title}`);
      console.log(`  page ${r.bodyBg} · ${r.rows.length} text nodes · focusables ${r.focusables} · :focus rules ${r.focusRules}`);
      const shown = [...bad].sort((a, b) => a.ratio - b.ratio);
      if (shown.length === 0) console.log('  FAIL  none');
      for (const x of shown) {
        console.log(`  FAIL ${x.ratio.toFixed(2)} < ${x.need.toFixed(1)}  ${String(x.size).padStart(3)}px ${x.color} on ${x.bg}  ${x.sel}  ${JSON.stringify(x.text.slice(0, 24))}`);
      }
      const deco = r.rows.filter((x) => !x.pass && x.decorative);
      for (const x of deco) console.log(`  deco ${x.ratio.toFixed(2)}  ${x.sel}  ${JSON.stringify(x.text.slice(0, 20))} (excluded from --fail)`);
      const ring = r.focusRing;
      const invisible = ring.filter((x) => !x.visible).length;
      console.log(
        `  focus: ${r.focusRules === 0 ? 'no :focus rules' : `${r.focusRules} :focus rule(s)`} · ${
          invisible > 0 ? `ring invisible on ${invisible}/${ring.length} probe(s) (${ring.map((x) => x.ratio.toFixed(2)).join(', ')})` : `ring visible (${ring.map((x) => x.ratio.toFixed(2)).join(', ')})`
        }`,
      );
      const sizes = Object.entries(r.fontSizes).sort((a, b) => Number(a[0]) - Number(b[0]));
      console.log(`  sizes: ${sizes.map(([s, n]) => `${s}px×${n}`).join(' ') || 'none'}`);
    }
    console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} pair(s) below threshold`}`);
  }
} catch (err) {
  console.error('theme-contrast:', err instanceof Error ? err.message : err);
  process.exitCode = 2;
} finally {
  proc.kill();
  rmSync(profile, { recursive: true, force: true });
}

if (failMode && failures > 0) process.exit(1);
