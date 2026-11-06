# tracker.gg / Riot upstream reality check — 2026-11-07 00:47–00:57 (Africa/Cairo)

Task: is the TRN break upstream (tracker.gg/Riot changed) or in Recon?

## Verdict: **upstream changed** — tracker.gg gates the keyless API behind an interactive captcha

The keyless `api.tracker.gg` endpoints Recon uses now answer a browserless client with
`429 {"errors":[{"code":"Warden::Challenge","message":"You are making too many requests and
must solve a captcha to continue.","data":{}}]}` — tracker.gg's own challenge tier, not
Cloudflare's 1015 page. It does not clear with time, and Recon's transport can never solve it.

## Evidence

### Vantage A — this server (Proton VPN, Swiss exit 169.150.197.99, AS212238 Datacamp)

| Request | Result |
|---|---|
| `curl https://api.tracker.gg/api/v2/valorant/standard/profile/riot/Test%23EUW` | **403**, HTML, `server: cloudflare`, `cf-ray …-ZRH` |
| Same + Chrome 153 UA, `Origin/Referer: https://tracker.gg`, sec-ch-ua/sec-fetch | **403**, identical 4,400-byte page |
| Body text | *"You've Been Blocked – Tracker Network … **VPN Users: If you are using a VPN, please try disabling it** … Scrapers: Please do not scrape our website … We offer an API at TRN Developers"* |
| `https://tracker.gg/` from the same box | 403, `cf-mitigated: challenge` (Cloudflare JS challenge) |
| `https://api.tracker.gg/robots.txt` | 429 `Warden::Challenge` (same captcha JSON) |

So the server's bare-curl 403 is an **egress/ASN block + Cloudflare challenge**, decided before
the API's own logic. It is **not** evidence of an API change, and it is **not** representative of
the shipped app (which runs on a residential line).

### Vantage B — the user's Windows PC, residential Egyptian IP (this egress only, read-only curl)

| Request | Result |
|---|---|
| bare curl, profile URL | 403 (block page) |
| Chrome-UA + `Origin/Referer/Accept: application/json` | **429**, JSON, 134 B |
| Same + cookies jar from `https://tracker.gg/` (site itself returned 403) | 429, same body |
| Same + `X-Warden-Challenge-Passed: 1` (fake) | 429, same body |
| matches URL `…/matches/riot/Test%23EUW?type=competitive` | 429, same body |
| **same request again after 95 s of total silence** | **429, same body — no self-clear** |

Response headers on every 429:

```
server: cloudflare
access-control-allow-origin: https://tracker.gg
access-control-expose-headers: X-Warden-Challenge-Passed
cache-control: no-cache, no-store, max-age=0
cf-cache-status: BYPASS
set-cookie: __cf_bm=… ; __cflb=…
```

`access-control-expose-headers: X-Warden-Challenge-Passed` is the tell: tracker.gg's own
frontend reads a Warden pass token from responses and replays it on later calls. A bare
`fetch()` has no pass, so it is parked in the captcha tier indefinitely.

### Vantage C — third parties, current period

- Custom code, 2026-11-03: *"Automating tracker.gg (e.g. Playwright) would mean getting past
  their Cloudflare bot protection and breaking their terms, so a person reads every rank …
  Manual lookup is the only rank source for current seasons right now."*
  ([rl-replay-review#47](https://github.com/distortion2112/rl-replay-review/pull/47))
- 2026-09-05 PR titled *"fix: Tracker.gg not working (403)"*; the fix is header/UA/origin
  tuning plus the Overwolf `TRN-API-Key` — i.e. clients now need a key and a plausible origin.
  ([RocketLaunchpad#120](https://github.com/Ghosty920/RocketLaunchpad/pull/120))
- tracker.gg homepage scanned **200** by urlscan's Chrome on 2026-11-04 → the site itself is up
  and serving; this is client gating, not an outage.

### Why Recon cannot pass it (app side as designed)

- `src-tauri/src/trn_proxy.rs:733-745` — the in-page transport is
  `fetch(url,{credentials:'include'})`; **no headers of any kind**, no Warden pass, no captcha UI.
- `src-tauri/src/trn_proxy.rs:66-68` — hidden window lives on `https://tracker.gg/`, `API_BASE`
  is `https://api.tracker.gg` (unchanged, still the right host).
- `src/utils/trn.ts:815,1667,1711` — profile / matches / match-detail paths (unchanged shape).
- `src/utils/trn.ts:19-29,48-61,703` — gate and cooldown ladder were built for Cloudflare
  **1015/429/403**; a Warden 429 is bucketed as an ordinary rate-limit, so the app retries
  forever in 25–60 s cool-offs. That is the observed "tracker stopped working" surface.
- `grep -rn -i "warden\|captcha" src/ src-tauri/src/` → only the VALORANT agent/rifle named
  Warden. **No captcha handling exists in the app.**

### Riot side: fine

- `https://valorant-api.com/v1/seasons` → 200; V26 acts present, current act 2026-06-24 → 2027-01-06.
- `src/utils/tracker.ts:400-482` derives act labels from that API at runtime (no hardcoded act
  table), so Riot's season rollover cannot hard-break the mapping by itself.
- Game version 13.09 / branch release-13.09 confirmed by the lead; nothing Riot-side is implicated.

## Ranked upstream failure modes

1. **Interactive captcha gate on the keyless API (observed, near-certain).** Human-solvable,
   machine-unpassable. This alone stops Recon.
2. **VPN/ASN + bot block at the Cloudflare edge (observed).** Blocks this server entirely;
   would also block any user on a VPN.
3. **API-key/origin requirement creeping in (evidence from third-party fixes).** Would need the
   official TRN API (`TRN-Api-Key`), not the site's keyless endpoint.
4. API path/version change — **not observed**: the paths still resolve far enough to answer
   with a Warden challenge, so routing is intact.

## Could not verify

- Whether tracker.gg's frontend currently succeeds for a logged-in human in a normal browser on
  the same PC (would need the user's interactive browser; not touched).
- The exact date the Warden tier was introduced. The app's code was designed against Cloudflare
  1015/403, and no captcha handling exists, so it predates this gate.
- Whether the PC's IP was pushed into the captcha tier by the app's own retries or by a new
  global rule. It does not change the outcome: after 95 s idle the gate persists, and Recon
  cannot solve a captcha either way.

## Reproduction

```bash
bun scripts/probe-trn-warden.ts Test#EUW        # profile
bun scripts/probe-trn-warden.ts Test#EUW matches # matches
# run it on the target machine: VPN exit → 403 block page, residential → 429 Warden
```
