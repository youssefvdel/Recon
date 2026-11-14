#!/usr/bin/env bun
/**
 * Probe tracker.gg's keyless profile API exactly like Outpeek's hidden WebView2
 * transport would (bare fetch, browser-ish headers, no key), and print what the
 * gate answers. Run it on the machine whose egress you care about: a VPN exit
 * sees a different answer than a residential line.
 *
 *   bun scripts/probe-trn-warden.ts                  # Test#EUW
 *   bun scripts/probe-trn-warden.ts Player#TAG
 *   bun scripts/probe-trn-warden.ts Player#TAG matches
 *
 * Read-only: one GET, no retries. Exit 0 = JSON from the API, 1 = gated.
 */
const [, , raw = 'Test#EUW', kind = 'profile'] = process.argv;
const [name, tag] = raw.split('#');
if (!name || !tag) {
  console.error('usage: bun scripts/probe-trn-warden.ts Name#TAG [profile|matches]');
  process.exit(2);
}

const id = `${encodeURIComponent(name)}%23${encodeURIComponent(tag)}`;
const url =
  kind === 'matches'
    ? `https://api.tracker.gg/api/v2/valorant/standard/matches/riot/${id}?type=competitive`
    : `https://api.tracker.gg/api/v2/valorant/standard/profile/riot/${id}`;

const res = await fetch(url, {
  // Same shape as trn_proxy.rs kick_script: no API key, no challenge header.
  credentials: 'omit',
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0',
    Accept: 'application/json, text/plain, */*',
    Origin: 'https://tracker.gg',
    Referer: 'https://tracker.gg/',
  },
});

const body = await res.text();
console.log(`GET ${url}`);
console.log(`status      ${res.status} ${res.statusText}`);
console.log(`content-type ${res.headers.get('content-type')}`);
console.log(`cf-ray      ${res.headers.get('cf-ray')}`);
console.log(`cf-mitigated ${res.headers.get('cf-mitigated') ?? '-'}`);
console.log(`allow-origin ${res.headers.get('access-control-allow-origin') ?? '-'}`);
console.log(`expose      ${res.headers.get('access-control-expose-headers') ?? '-'}`);
console.log(`body        ${body.slice(0, 240).replace(/\s+/g, ' ')}`);

const gated = body.includes('Warden::Challenge') || body.includes("You've Been Blocked");
process.exit(gated ? 1 : 0);
