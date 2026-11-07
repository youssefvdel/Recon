# tracker.gg enrichment postmortem — dead 2026-11-02, replaced by local Riot reads

Durable record for a maintainer reading this months from now. If you are looking at a
"tracker stats stuck on Fetching…" bug: **tracker.gg is gone for this app, by design, since
2026-11-02.** The replacement is Riot's local client endpoints. Do not re-add the TRN web
path to the hot path; see the rules at the end.

Scope: the TRN enrichment (lobby rank/RR, act K/D/ACS/win%, matches) in `src/utils/trn.ts`
and the hidden WebView2 transport in `src-tauri/src/trn_proxy.rs`.

## 1. Timeline

| When (local, UTC+2) | What |
| --- | --- |
| 2026-10-14 10:50 | `0.5.0-alpha` built (the shipped binary). |
| 2026-10-23 23:10 | Installed on the user's PC. |
| **2026-11-02 16:28:38** | **Last successful tracker.gg response.** The app's own cache holds it (`trn-cache-v1 1793629718266 …profile…`); the cache directory's mtime equals that instant and nothing was written after. |
| 2026-11-02 17:07:25 | Windows `Tcpip` event 4266: "a request to allocate an ephemeral port number from the global UDP port space has failed…". **Correlation only** — 39 min after the last good fetch, consistent with a QUIC/HTTPS retry storm, not proven to be this app and not proven to be the cause of the wall. |
| 2026-11-06/07 00:46–01:13 | Probes from the team server (VPN egress) and from the user's PC (residential IP): 403 block page, 429 `Warden::Challenge`, 95 s persistence test. The gate is reproduced from a clean residential line, so it is not our network. |
| 2026-11-07 | Fix branch `fix/trn-captcha`: local Riot rank/act stats replace TRN; captcha classified and surfaced. |

Break window: **after 2026-11-02 16:28 and before the first failing attempt.** A fresh
upstream change in early November 2026, not a long-standing state.

## 2. The wall

`https://api.tracker.gg/api/v2/valorant/standard/profile/riot/<name>%23<tag>` with a
browser-realistic request from **the user's PC** (residential IP, exact WebView2 UA,
`Origin/Referer: https://tracker.gg`, `Accept: application/json`):

```
HTTP/1.1 429 Too Many Requests
server: cloudflare
access-control-allow-origin: https://tracker.gg
access-control-expose-headers: X-Warden-Challenge-Passed
cf-cache-status: BYPASS

{"errors":[{"code":"Warden::Challenge","message":"You are making too many requests and
must solve a captcha to continue.","data":{}}]}
```

- **It is a captcha tier, not a rate limit that expires.** After **95 s of total silence**
  the same request still returned the same 429.
- **A bare fetch cannot carry the pass.** The exposed response header
  `X-Warden-Challenge-Passed` is the token tracker.gg's own frontend reads and replays;
  without a human captcha there is no token to replay. A forged header value does not work.
- **A separate, harder block also exists.** Non-browser clients get **403** with a
  tracker.gg-authored page titled *"You've Been Blocked - Tracker Network"*, which says
  "VPN Users: …please try disabling it" and "Scrapers: please do not scrape our website".
  The same 403 hits `https://tracker.gg/` and the profile path. From the team server
  (VPN/datacenter egress) this 403 is what you see; from a normal residential line the API
  answers 429 Warden instead.
- Reproduced on 2026-11-06 and 2026-11-07, twice ~5 minutes apart, with two different
  browser UAs. UA quality makes no difference.

Minimal repro (any machine; VPN exits see the 403 instead):

```bash
curl -sS -i 'https://api.tracker.gg/api/v2/valorant/standard/profile/riot/Test%23EUW' \
  -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0' \
  -H 'Accept: application/json' -H 'Origin: https://tracker.gg' -H 'Referer: https://tracker.gg/'
```

## 3. Why the app could not pass it

- The transport was a hidden WebView2 window on `https://tracker.gg` doing
  `fetch(url, { credentials: 'include' })` (`trn_proxy.rs`, `kick_script`). The request has
  **no custom headers**, no pass token, and the hidden window has **no captcha UI** — it is
  invisible and never focused, so a human could not solve one there even if it rendered.
- The client string-matched `429`/`403` and classified the response as a **rate limit**
  (`trn.ts` gate). Backoff stepped 25 s → 50 s → 60 s and repeated forever. The wall never
  clears, so this was an infinite silent retry loop.
- Call sites swallowed every failure (`.catch(() => {})`), so "broken forever" looked
  exactly like "still loading". The UI stayed on `Fetching tracker.gg stats…`.
- The release build compiles `trn_trace!` out (`#[cfg(debug_assertions)]`) and initialises
  no logger, so the shipped app produced **zero diagnostics** for this incident.

## 4. Why an API key does not rescue it

- The official Tracker Network developer API does **not license VALORANT**. Its FAQ lists
  Apex Legends, The Division 2, Splitgate (deprecated) and CS:GO (deprecated) and says:
  *"We are not allowed to provide APIs for other games. Please do not ask for a key, it
  won't be granted."* Production use also needs Discord whitelisting, and scraping is
  explicitly forbidden.
- Even for a licensed title, the captcha sits **in front of auth**: a request carrying a
  (bogus) `TRN-Api-Key` still returned the same 429 `Warden::Challenge` from the user's PC.
- HenrikDev (`api.henrikdev.xyz`) is a viable keyed alternative but is **key-only** now:
  every endpoint including `/v1/status/eu` returns 401 without a key.

## 5. The decision: read Riot locally instead

Evidence (live, 2026-11-07, using the app's own local-client token):

| Read | Result |
| --- | --- |
| `GET pd.<shard>.a.pvp.net/mmr/v1/players/<any PUUID>` | **200** for another player — 27 seasons, tier, RR, peak data |
| `GET …/match-history/v1/history/<any PUUID>` | **200** for another player (95 rows) |
| `GET …/match-details/v1/matches/<matchId>` | **200** for a match the local account never played (10 players) |

The same token/index the app already used for itself therefore answers for **arbitrary
PUUIDs and match IDs** — which is what tracker.gg was being asked for.

What the app reads now (`src/utils/tracker.ts`, `src/utils/actStats.ts`):

- **Rank, RR, peak, leaderboard rank, act games/wins** — `fetchLocalRank` →
  `parseLocalRank` on `/mmr/v1/players/{puuid}`. Throws instead of inventing a value.
- **Act K/D, win %, ACS** — `fetchLocalActStats`: the act window is exact, not guessed;
  `/mmr/v1` says how many competitive games the act holds and the aggregator reads
  precisely that many newest matches. A partial or unreadable window is **refused** rather
  than labelled "act". Cap `LOCAL_ACT_MAX_MATCHES = 50` (Riot history is seen capped near
  95 rows); an act longer than the cap reports "too long" and stays blank.
- **Party, incognito flag, account level** — local presences and the core-game/pregame
  match payloads, unchanged.

**Fields with no local source** (no data, or not in the payload): headshot %, KAST, damage
delta, percentiles, Tracker Score, country, and agent/map breakdowns. They stay blank or
are explicitly labelled estimated (the performance score is the app's own estimate, never
presented as Riot's). Do not fabricate them to fill the old layout.

Safety: this endpoint returns the **public competitive tier and RR** — the same values the
game shows on the career/Act Rank screens — not hidden/raw MMR. A field-level check of the
payload (97 distinct keys) found no `MMR`/`raw` field; the only "hidden" token is
`IsActRankBadgeHidden`, an act-badge display flag. The repo rule stands: never claim MMR.
All of it is read-only GETs over the local client's own session; treat the endpoints as
unofficial and their absence as non-fatal.

## 6. What remains in the codebase

The TRN transport is **still present and still compiles**, but it is a cold fallback and
must never become the hot path again:

- `trn_proxy.rs` recognises the Warden body and returns `TRN_CAPTCHA_REQUIRED` instead of
  a generic `HTTP 429`.
- `trn.ts` classifies that **before** the cooldown ladder: no ladder step, no path-fail
  stamp, no retry on the wire. It is `TrnHealth = 'captcha'`.
- `TrnStatusBanner` shows the verdict and, for captcha, offers **Verify** (opens the one
  *visible* window via `trn_verify_open` where a human can solve the challenge) and
  **I finished** (`trn_proxy_reset` + cooldown/health reset; the next hidden fetch inherits
  the earned cookies).
- `fetchTrnStatsNow` tries local Riot first and only falls through to TRN while
  `getTrnHealth().health === 'ok'` and the cooldown is zero.

**Plain statement: TRN is not expected to work without a human captcha.** It can only
recover if a user completes the verification window on their own machine. Budget nothing
on it.

## 7. Rules for future maintainers

1. **Never put a human-gated wall behind a silent retry loop.** If clearing a failure needs
   a captcha, a browser, or any user action, the client must stop retrying, say so in the
   UI, and offer the user the action. Exponential backoff cannot fix a wall a timer cannot
   cross.
2. **Surface transport failures.** A health verdict and a visible banner are mandatory for
   any external data source; silent `.catch(() => {})` on a network path is how this
   incident stayed invisible for days.
3. **Prefer local Riot data.** It needs no key, no third party, no captcha, and it is the
   same trust boundary the app already uses.
4. **Never scrape tracker.gg.** Their block page names scraping and legal action; their
   terms allow only licensed titles through the official API, and VALORANT is not one.
5. **Never claim MMR.** Rank/RR from Riot is public display data; the hidden rating is not
   obtainable and this app must not pretend otherwise.

## References

- `docs/upstream/tracker-gg-verdict.md` — the wall, the egress difference, the 95 s test.
- `docs/upstream/data-source-decision.md` — TRN key vs HenrikDev vs local Riot, with the
  measured request/response samples.
- `ROADMAP.md` — "tracker.gg public API — dead since 2026-11-02" (the one-line dead end).
- Code: `src/utils/trn.ts`, `src/utils/tracker.ts`, `src/utils/actStats.ts`,
  `src-tauri/src/trn_proxy.rs`, `src/components/TrnStatusBanner.tsx`.
