# Judge checklist — one page, PASS/FAIL per line

Run this against any build. Every line ends in **PASS** or **FAIL**; "looks good" is not a verdict.
Cite the command output or screenshot path next to each line. Derived from `regressions.md`,
`design-ui.md` (§2, §5) and `design-data-layer.md` (§3–§5).

## A. The ten regressions — each under two minutes

| # | Check | Must see | Failure looks like |
|---|---|---|---|
| 1 | **WebView2 complete.** Server: `test $(stat -c%s src-tauri/webview2-runtime/msedge.dll) -ge 300000000`. PC: `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" \| ? ParentProcessId -eq (Get-Process recon).Id`. | DLL ≥ 300 MB; one `msedgewebview2.exe` child of `recon.exe`; a window exists. | No child, no window, process alive but invisible. |
| 2 | **fixedRuntime path.** `bun -e "const c=require('./src-tauri/tauri.conf.json');console.log(c.bundle.windows.webviewInstallMode)"`. | `{type:'fixedRuntime', path:'webview2-runtime'}`; installer places that folder beside `recon.exe`. | `./…`, absolute path, or missing folder at install. |
| 3 | **Bridge loopback.** PC: `netstat -ano \| findstr 9223`. Server: `curl --max-time 3 http://192.168.100.3:9223/`. | Listener is `127.0.0.1:9223` only; server curl fails/times out. | `0.0.0.0:9223` or any HTTP answer from the server. |
| 4 | **404 shapes settle.** `bun scripts/trn-cache-check.ts`; open a lobby with unknown players. | Both `HTTP 404` and `TRN_NO_DATA` are terminal; no row stays "fetching" past one poll; no re-query storm. | Spinner/across-poll refetch of the same puuid. |
| 5 | **Pause belongs to the transport.** `grep -n "canServeDirect" src/utils/trn.ts`; during a match confirm the board fills. | One predicate used by both the gate and the transport; direct path fills mid-match. | Board empty only during coregame; edge-only rule applied to direct. |
| 6 | **Riot guard on /mmr.** `grep -n "assertRiotOk(j, 'mmr')" src/utils/tracker.ts`; feed a 403 fixture to the rank path. | Every MMR read guarded; error throws or keeps last-known rank, never tier 0. | "Unrated" over a player with a known peak. |
| 7 | **No downgrade.** `bun scripts/update-guard-check.ts`; Settings → Check for Updates on Early Access. | Only strictly newer offered; equals current → "latest". | An older `alphaN` with an Install button. |
| 8 | **Pruner keeps the live prefix.** `grep -n "recon_trn_cache_v" src/utils/tracker.ts src/utils/trn.ts`; launch the app twice with a marker entry. | Live `…_v2` prefix is not in `SUPERSEDED_PREFIXES`; marker survives two launches. | TRN cache empties every launch. |
| 9 | **Quota-safe writes.** `grep -n "writeLocalSafe" src/utils/*.ts`; after 10 min check newest `recon_match_v7_*` exists. | Writes go through `writeLocalSafe`; newest cache key present; no "fetch again every launch". | Data shown but cache keys absent / silently stale. |
| 10 | **Overlay cannot abort startup.** `grep -n "build_overlay_window" -A6 src-tauri/src/lib.rs`; dev build: point the overlay URL at a bad path. | Overlay built inside setup with `match`; failure logs once and main window works; `OVERLAY_AVAILABLE=false`. | App exits or has no main window when the HUD fails. |

## B. Board state rules — five screenshot checks (`design-ui.md` §2, §5)

| # | Check | Must see | Failure |
|---|---|---|---|
| 11 | **Dash is local-empty only.** Lobby row where Riot returns empty for a local field. | A dash with a tooltip naming the local source; no dash on Tracker cells. | Dash on Tracker values, or dash while pending. |
| 12 | **Lock is Tracker-private only.** Player whose Tracker profile is 451/private. | Lock inside the Tracker appendix only; rank/level/party never locked. | Lock on a local cell, or lock inferred from a failed fetch. |
| 13 | **Pulse has a deadline.** Open a lobby; screenshot immediately and 15 s later. | At most one pulse, in the Tracker group header; gone at the 12 s timeout, replaced by "Tracker unavailable". | Per-cell pulses/spinners, or a pulse that outlives 15 s. |
| 14 | **`as of` on every Tracker number.** Expand the appendix on a populated row. | Every Tracker value carries `as of 3m` (<24 h) or `as of 2 Nov`; values older than 7 days are absent. | Any Tracker number without a stamp, or an old value shown as fresh. |
| 15 | **TS is gone from the board.** Screenshot + `grep -rn "Tracker Score" src/components/LiveMatchView.tsx`. | No TS column, no Tracker Score on the board (Overview archive banner is allowed). | Any TS/Tracker Score cell on the board. |

## C. Data-layer invariants — grep-shaped, run at review time

| # | Check | Must see |
|---|---|---|
| 16 | `grep -rn "export .*riotGet" src/` | No exported `riotGet`; raw transport lives only in `src/sources/riot.ts`. |
| 17 | `grep -rn "recon_\(live_player_stats\|live_rank\|match_v7\|trn_negative\|trn_cooldown\)" src/ \| grep -v "src/cache/\|src/sources/trn.ts"` | No prefix literals outside the namespace owners. |
| 18 | `grep -rn "createNamespace(" src/cache/` | Every prefix derived; generation declared beside its owner; `pruneAll` walks only the registry. |
| 19 | `grep -rn "pause" src/transport.ts` and `grep -rn "EDGE_PAUSED" src/` | Pause only in the `edge` gate variant; `direct` has `gates: []`; `runGates` exhaustive. |
| 20 | `grep -rn "TRN_NO_DATA\|HTTP 404" src/ \| grep -v "src/sources/trn.ts"` | Only the TRN source maps these words; views consume `TrnError` kinds, never substring-match. |
| 21 | `grep -rn "trnState" src/components/` and `grep -rn "Validated<" src/` | No `trnState` in views; `Validated<…>` is the only parser input type. |
| 22 | `grep -rn "FieldView" src/components/` | Stats render only through `FieldView`; no per-view `toFixed`/hide logic. |

*Checks 16–22 encode the target design. On a build that predates the rewrite they legitimately read FAIL — record the FAIL; do not waive it.*

## D. Live-match protocol — no storage clearing, ever

1. Fresh launch (no resets). Join or observe a live match; do not touch localStorage.
2. At AGENT SELECT record the timestamp; at coregame start the 60 s clock.
3. Must see by +60 s: rank + peak for all ten; ACS/K-D/Win%/HS% filled or a settled label; no `Unrated` over a player whose peak exists (Riot tier 0 only if genuinely unranked); no TS cell; every Tracker value stamped.
4. If the board is empty, first prove whether a request was issued (bridge/console or a direct `trn_http_get`), then capture the failing `/mmr` or profile body. Clearing storage invalidates the test and is a FAIL of the protocol.
5. After the match: ranks persist across the next launch; live keys are `recon_live_player_stats_v3` and `recon_live_rank_v1`; opening one match detail creates `recon_match_v7_<id>`; no `…_v2`/`…_v5`/`…_v6` keys remain.
6. Record: PASS/FAIL per line above, plus one screenshot of the filled board and one of the 15 s post-open state.

**Verdict line:** every one of 1–22 and D3–D5 marked PASS or FAIL with evidence; the build passes only if all are PASS.
