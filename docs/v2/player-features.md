# Player-expected features — evidence pack

Research date 2026-11-10. **This file quotes demand; it does not invent one.**

Method: searched r/VALORANT and r/VALORANTCompetitive, OP.GG / Tracker.gg / Valtracker
feature pages, Dexerto's tracker round-up, popular GitHub VALORANT tools and Riot's
public developer-relations issue tracker, and the Overwolf store reviews of the official
Tracker.gg app. Reddit blocks direct fetches, so threads were read through the public
**Arctic Shift** archive API (`arctic-shift.photon-reddit.com`) and every quote below is
verbatim from the linked thread. Statements without a link are marked **[inference]**.

## 0. What Recon already ships (do not "add" these)

From `README.md`: true stretch, sensitivity matcher, resolution switcher + safe-mode
watchdog, GPU scaling panel, lobby scouting (rank, peak, RR, act W/L, K/D, win %, HS %,
24 h record, party colours, incognito), in-game HUD widgets, match history and match
detail with round timeline, store view, loadout viewer, Riot chat view.

## 1. Demand evidence (verbatim)

| Player want | Quote | Source |
| --- | --- | --- |
| Party reveal in lobby | "I really like this feature! Well done!" — and the tracker rep explains: "To detect a party, we're checking if players have queued together recently." | [r/VALORANT — See Who's Queued Together In Real-Time](https://www.reddit.com/r/VALORANT/comments/17kqagc/see_whos_queued_together_in_realtime/) |
| Deeper party/queue history | "as a premium member, will it soon extend past the 25 matches?" | same thread |
| Who a player queued with | "Premades share a color on the roster. Parties are inferred from recent matches." / "Open a player to see who they queued with in their last 12 games, and which agents they play most." | [ruwiss/valorant-tracker README](https://github.com/ruwiss/valorant-tracker) |
| Recent teammates / encounter log | "Match Insights — Per-map kill/death heatmaps and your most-played recent teammates"; "cross-session encounter log" | [Statics README](https://github.com/faheem-s27/Statics-Public), [Valorant Scout README](https://github.com/kryotrades/valorant-scout) |
| Post-match visual analysis | "Detailed scoreboard, economy and round-by-round breakdowns" | [Statics README](https://github.com/faheem-s27/Statics-Public) |
| Interactive minimap / positions | "Interactive Minimap — Round-by-round replay of player positions, spike plants and kills on the map" | same |
| Live positions are loved | "I love this addition … the ability to expand the map to see Live Player Positions." Tracker.gg reply: "Having the location (and direction) of placed abilities is something we've requested from Riot, **it's not data we have right now**." | [r/VALORANTCompetitive — Tracker.gg esports data](https://www.reddit.com/r/ValorantCompetitive/comments/1i2tyqk/trackergg_has_valorant_esports_data_now/) |
| Round-by-round combat stats | "Check your round-by-round combat stats — including kills/deaths, damage dealt, and headshot ratio — in real time with the overlay." | [OP.GG Valorant features](https://op.gg/desktop/en/games/valorant) |
| Rank/RR progression | "MMR & Rank History — Track rank progression with win/loss history and your all-time peak rank"; "RR progression" | [Statics README](https://github.com/faheem-s27/Statics-Public), [ValTracker](https://val-tracker-gg.vercel.app/) |
| Store wishlist + alerts | "Wishlist & Alerts — Wishlist skins and get notified when they appear in your shop"; Valtracker: "customized skin wishlist, and send you notifications when items on that list go on sale" | Statics README; [Dexerto tracker round-up](https://www.dexerto.com/valorant/best-valorant-stat-trackers-to-use-in-2023-2090718/) |
| Clip capture control | "PLEASE make a selectable thing where u can choose how many kills u want to get a clip, just because i want to capture my aces,4k/3k doesn't mean i want t[o]…" (4★ review) | [Overwolf — Valorant Tracker app](https://www.overwolf.com/app/tracker_network-valorant_tracker) |
| Performance / reliability | "it started making my valorant game lag incredibly hard whenever i hover over any UI elements … drop to 10fps"; "barely ever works and even if it does only some of the features work" (1–2★ reviews) | same Overwolf page |
| No ads, no Overwolf dependency | "the ads are annoying, I wish there could be other ways to monetize. And it annoys me it's under another app, which can possibly also steal data." | [r/VALORANT — Alternative to Valorant Tracker?](https://www.reddit.com/r/VALORANT/comments/1244oh7/alternative_to_valorant_tracker/) |
| Crosshair-placement feedback | "it would be cool … if it can track crosshair placement … and give me a percentage of the times you fail to the times you don't" | [r/VALORANT — deathmatch tracker](https://www.reddit.com/r/VALORANT/comments/1g5uw2l/i_care_too_much_about_deathmatch_so_i_created_a/) |
| Headshot/weapon-choice stats | "Wish Valorant had an API that tracked data so you could track headshot accuracy, weapon choice and so much other stuff" | same thread |
| Replays | "anything that helps us fill the void of still not having replays (Rito pls!)" | r/VALORANTCompetitive thread above |
| Ability-impact stats | "there is no way to track ability impact … how many enemies you flashed or how much damage you made with your molotov" | [Riot developer-relations #729](https://github.com/RiotGames/developer-relations/issues/729) |
| Leaderboard lookup | "we can only query 200 players in one step … 75 queries … for the position of a single player" | [Riot developer-relations #936](https://github.com/RiotGames/developer-relations/issues/936) |
| Ranked rating for a chatbot | "a command to return their ranked rating on VALORANT … not possible for all users when using the official API" | [Riot developer-relations #922](https://github.com/RiotGames/developer-relations/issues/922) |
| Account level (for smurf suspicion) | "we must be able to obtain player's account level … to make our anti-cheat system which will separate players who may be suspected of smurfing" | [Riot developer-relations #765](https://github.com/RiotGames/developer-relations/issues/765) |
| Live client data (agent/weapon/ability) | "It would be nice if The Live Client Data API would have support for Valorant" | [Riot developer-relations #618](https://github.com/RiotGames/developer-relations/issues/618) |

## 2. Honest feasibility, per demand

Sources we own: local Riot client readers (`mmr`, `match-history`, `match-details`,
`presences`, `store`, `loadouts`, GLZ live match) — see
`docs/architecture/data-sources.md`. No memory reads, no injection, no mutating calls.

| Demand | Data we have | Build tonight? |
| --- | --- | --- |
| Lobby rank/peak/RR/party/level | shipped already | — |
| Opponents' / teammates' recent form and "who they queue with" | `match-history` answers for **any** PUUID; `match-details` has `partyId` per player | **Yes** — readers exist, UI work only |
| Post-match advanced scoreboard (KAST, ADR, traded deaths, first blood, economy) | `roundResults[].playerStats[]` already parsed in `src/sources/matchDetails.ts` | **Yes** — pure computation, no new network |
| Rank/RR progression chart (per act, session) | `mmr` seasons + `competitiveupdates` (~20 recent) | **Yes** |
| Session summary ("today: W/L, RR delta, best game") | local match cache + `competitiveupdates` | **Yes** |
| "Recently played with" list with lookup | `match-history` + local namesets | **Yes** |
| Store wishlist + Night Market alert | `readStorefront` exists (`src/sources/riot.ts:612`) | **Yes**, needs polling + notification design |
| Clip markers (3k/4k/ace round, weapon, time) | `roundDetails` kills/rounds | **Yes** (markers only — no video capture) |
| Battle-pass progress | not in the reader set; local `/contracts`-style read needed | Medium — new read, verify endpoint |
| Interactive minimap / kill heatmap | kill `playerLocations`/`victimLocation` and plant locations are in `match-details` | Medium — needs map-coordinate calibration + UI |
| Per-map kill/death heatmaps | computed from match details | Medium — same calibration |
| Weapon stats (personal) | per-kill `finishingDamage.damageItem` + `gameData` weapon names | Yes — low effort |
| Playtime | `matchInfo.gameLengthMillis` summed | Yes — low effort |
| Ability impact (flashes, molotov damage) | **not in Riot's match data** — Riot dev-rel #729 confirms | No |
| Live player positions / ability locations | not exposed by the local client; GEP/memory only | **Banned** |
| Replays | Riot provides none; users say so too | No |
| Crosshair-placement % / aim tracker | needs screen-capture + vision pipeline (OP.GG's Aim Tracker is that) | No — new pipeline, not tonight |
| Instalock / auto-accept / queue automation | would be mutating Riot calls | **Banned** |
| Social feed / LFG / global chat | needs a backend and mutating social calls | Out of scope |
| Smurf score / hidden MMR / win probability | no real data; would be fabricated | **Do not build** (see §4) |

## 3. Ranked: value × buildable-tonight

Order = player value × confidence we can ship it from data we already read.

1. **Lobby "recent form" + who they queue with** — highest. Turns the existing rank
   card into a scouting panel: last N matches, win %, K/D, most-played agents, party
   links. Data: `match-history` (any PUUID) + `match-details.partyId`. Readers already
   exist; work is UI + caching. Evidence: Statics/Scout/ruwiss features above.
2. **Post-match advanced scoreboard (KAST, ADR, traded, first blood, econ)** — the
   round data is already parsed; this is arithmetic plus one table. Evidence: Statics
   "detailed scoreboard, economy and round-by-round", OP.GG round report.
3. **Rank/RR progression + session summary** — a graph and a "today" strip built from
   `competitiveupdates` + cached matches. Evidence: Statics "MMR & Rank History",
   ValTracker "RR progression".
4. **Recently played with / encounter list** — from match history + namesets; one
   screen, no new network surface.
5. **Store wishlist + Night Market alert** — existing storefront reader; needs a
   scheduler and a notification surface. Evidence: Statics wishlist, Dexerto/Valtracker.
6. **Clip markers** (which rounds were 3k/4k/aces, weapon and time) — cheap and
   honest; actual video capture stays out of scope.
7. **Weapon/playtime stats** — low effort, low risk.

Roadmap (documented, not tonight): interactive minimap + heatmaps (map calibration),
battle-pass progress (new local read), OBS/browser overlay, lineup library (content),
mobile companion, esports data (external source), aim/crosshair vision (new pipeline).

## 4. Traps — features every tracker has that we deliberately do not copy

- **Hidden/raw MMR.** No client or API exposes it. A site that shows one number is
  "running its own formula on the same data … treat it as an estimate"
  ([agatasmurf MMR checker](https://agatasmurf.com/valorant-mmr-checker/)). Our
  `ROADMAP.md` already forbids claiming it.
- **Smurf score.** Products sell a "smurf detector" that "flags likely smurfs before
  round one" from level + K/D + peak + win rate
  ([valorantscout.com](https://valorantscout.com/valorant-smurf-detector)); Riot
  dev-rel #765 shows the same wish from developers. It is a heuristic dressed as a
  verdict. We may show the **facts** (level, rank, recent record); we must not print a
  score.
- **Proprietary performance score.** Tracker Score is "scored out of 1,000 points based
  on their performance relative to the total player population"
  ([tracker.gg announcement](https://tracker.gg/articles/tracker-score-our-new-performance-rating)) —
  we do not have the population model. Any score we show must be our own formula,
  labelled as ours.
- **Predictive win chance.** **[inference]** No VALORANT source found in this pass that
  publishes a validated model; a number would be invented. Do not build.
- **"Cheater detection".** **[inference]** Read-only data cannot prove cheating; a flag
  is an accusation. Do not build.
- **Auto-lock / auto-accept / queue automation.** Mutating Riot calls; banned by our
  safety rules (and the app's own `README` hover-only rule).
- **Memory reading / injection / radar.** Banned by `AGENTS.md` and Riot policy.
- **Scraping tracker.gg.** Their Warden captcha and terms; see
  `docs/tracker-gg-postmortem.md`.

## 5. Banned, not "hard"

- Memory reads, injection, overlays that need game internals (never).
- Any mutating Riot call: lock agent, accept queue, join/leave party, send friend
  request, chat automation.
- Live enemy positions or ability locations that Riot does not expose.
- Account automation (the [smurf account manager](https://github.com/fulmiiiiine/Smurf-Valorant-Manager)
  pattern — 2FA interception, automated accounts) is an outright violation.

## 6. Notes / open questions

- ACS vs Performance Score: one third-party blog says patch 13.06 replaced the
  scoreboard ACS with a 0–500 Performance Score
  ([RankSurge](https://ranksurge.games/blogs/news/valorant-stats-explained)) — **single
  source**, verify against a live client before relabelling our "ACS" UI.
- "Night Market" is in the storefront payload **[inference: from the store UI/API
  shape]**; verify before shipping alerts.
- The "25 matches" premium limit in the party thread is Tracker.gg's own cap, not
  Riot's — our match-history reader pages up to ~95.
