# TRN Valorant app 1.32.14 — file inventory

Package root: `docs/overwolf/captures/opk/extracted/` (189 files, from the official
`.opk` CDN zip). Chunk names are content-hashed by the bundler (Vite/Rollup); roles are
inferred from the components/strings each chunk contains.

## Top level (2 files)

| File | Size | Role |
| --- | --- | --- |
| `manifest.json` | 5,829 B | Overwolf WebApp manifest: `type: WebApp`, version `1.32.14`, `minimum-overwolf-version 0.290.0`, `minimum-gep-version 290.0`, permissions `Extensions, Streaming, DesktopStreaming, VideoCaptureSettings, Profile, GameInfo, Hotkeys, FileSystem`; `data.windows` (10), `game_events: [21640]`, `game_targeting: {type: dedicated, game_ids: [21640]}`, `launch_events: GameLaunch`, hotkeys (`toggle` Alt+T, `switch-view` Alt+L, `tab` passthrough), `url_protocol.schemes` = `overwolf-extension-ipmlnnogholfmdmenfijjifldcpjoecappfccceh`, `externally_connectable` = `*.overwolf.com, *.tracker.gg, *.tracker.network, *.thetrackernetwork.com, *.github.com, *.pvp.net, trackercdn.com` |
| `_metadata/verified_contents.json` | 7,599 B | Overwolf package integrity manifest (hashes of packaged files) |

## `windows/` — 10 HTML entry points (12,076 B total)

| File | Entry script |
| --- | --- |
| `background.html` | `/js/windows/BSj0SAG_.js` |
| `desktop.html` (also used by `ingame`) | `/js/windows/D4rg-gIm.js` |
| `second_screen.html` | `/js/windows/BABgp3Wf.js` |
| `duels.html` | `/js/windows/D-GTq3ef.js` |
| `teammates.html` | `/js/windows/BzjOSqAi.js` |
| `timeline.html` | `/js/windows/Cw9odwNh.js` |
| `guides.html` | `/js/windows/DIXWZmPO.js` |
| `assistant.html` | `/js/windows/DOdzI-fU.js` |
| `verification.html` | `/js/windows/1NrW1_TY.js` |
| `uninstall.html` | `/js/windows/ej4RcvaA.js` |

Each HTML also lists `modulepreload` links for shared chunks (e.g. `desktop.html`
preloads 21 shared chunks; `timeline.html` preloads 7).

## `js/` — 24 shared chunks (751,359 B)

| Chunk | Size | Role / evidence |
| --- | --- | --- |
| `DRRbEKrS.js` | 356,469 B | Vue framework + Highcharts (contains `defineComponent`, `highcharts`) — vendor bundle |
| `uYJbzOEK.js` | 199,635 B | vendor bundle incl. Socket.IO client |
| `DlCfbEQl.js` | 77,674 B | match/profile UI: components `CareerStats`, `MatchInfo`, `MatchStats`, `PlayerCareerStats`, `PlayerInfo`, `PlayerMatchStats` |
| `Cu_khBDY.js` | 29,755 B | **Tracker Network API service + model mappers** (`fetchProfile`, `fetchRecentMatches`, `fetchMatchDetails`, `fetchMultipleProfiles`, `fetchInsights`, `fetchSeasons`, `fetchGuides`, `fetchPremierTeamInfo`, `setPrivacy`) |
| `BuceaciP.js` | 20,400 B | game-logo components (`ValorantAppLogo`, `ApexLegendsAppLogo`, `FortniteAppLogo`, …) |
| `Cd0_c1Nz.js` | 18,248 B | shared UI (no component names in top sample) |
| `ygrTMjre.js` | 9,424 B | UI atoms: `ActionButton`, `CompetitiveRank`, `PartyIndicator`, `TrackerScore`, `Trial` |
| `BsYdn8Dh.js` | 5,718 B | helper/mixins (imported by timeline as `t as e`) |
| `B44rNLmI.js` | 5,666 B | helper (background imports `a as j, t as se`) |
| `B33CWD2L.js` | 5,533 B | `ValorantAppLogo`, `TrackerNetworkLogo` |
| `CHEZRxl4.js` | 3,203 B | helper |
| `tDb6fhXS.js` | 2,828 B | helper |
| `Wl3ijtL0.js` | 2,594 B | timeline icons (`c` kill, `u` death, `l` switch icon) |
| `C9-STseq.js` | 2,473 B | `LiveDuels` component |
| `P7hlqwcu.js` | 2,159 B | helper |
| `4vnQt_sg.js` | 2,058 B | helper |
| `CxytxNOL.js` | 1,567 B | helper |
| `DPMUv1hE.js` | 1,229 B | directives (`n` auth, `t` open-url) |
| `B53q1ZB5.js` | 1,035 B | helper |
| `BCHQMJxk.js` | 1,001 B | helper |
| `DkdZ5QtL.js` | 833 B | helper |
| `UAVvB--s.js` | 762 B | helper |
| `DjttlSeG.js` | 635 B | helper |
| `DIJlqWDn.js` | 460 B | helper |

## `js/windows/` — 10 entry chunks (370,456 B)

| Chunk | Size | Window | Role / evidence |
| --- | --- | --- | --- |
| `BSj0SAG_.js` | 102,433 B | background | Main service: GEP default + custom (log-file) provider, Riot Client Service, Socket.IO client, Discord RPC, window manager, OAuth, trials/monetization state |
| `D4rg-gIm.js` | 214,532 B | desktop/ingame | Full UI: home, match page, `RoundsTimeline`, `RoundWeaponsStats`, `EconomyHeading`, `Overview`, `DuelsHighlights`, `DuelsTable` |
| `BABgp3Wf.js` | 7,943 B | second_screen | Second-screen UI shell (imports shared chunks): `HighImpactAd`, `SubscriptionStatus`, match views |
| `Cw9odwNh.js` | 6,784 B | timeline | **In-game round timeline overlay**: `Timeline`, `MatchTimeline`, `Round`, stats bar |
| `BzjOSqAi.js` | 8,760 B | teammates | `CareerStats`, `PlayerInfo`, `TeammateCareerStats` |
| `DOdzI-fU.js` | 21,381 B | assistant | `ClassIcon`, `Reminder` |
| `D-GTq3ef.js` | 1,884 B | duels | compact live-duels window |
| `DIXWZmPO.js` | 3,143 B | guides | lineups/guides window |
| `1NrW1_TY.js` | 2,887 B | verification | account verification handoff |
| `ej4RcvaA.js` | 709 B | uninstall | uninstall survey |

## `css/` — 16 stylesheets (164,699 B)

`BtK0X12w.css` 101,530 B (main window styles) · `Bu8RBT7_.css` 28,079 B
(second-screen/desktop) · `BixQLclk.css` 10,358 B · `C4YYCT_q.css` 5,546 B ·
`D7nnlYGw.css` 2,697 B · `e7aI_GO7.css` 2,552 B · `DrngfWbi.css` 2,549 B ·
`DTnKcTl0.css` 2,259 B · `qMtZUIoB.css` 2,200 B · `B18klNWQ.css` 1,703 B ·
`BA-3rgGh.css` 1,513 B · `C8-WGRT5.css` 1,438 B · plus 4 smaller files.

## `assets/` — fonts, images (3,258,342 B)

- `assets/fonts/Rajdhani/` — Bold/Medium/Regular/SemiBold `.woff2` (~100 KB each)
- `assets/fonts/Roboto/` — Bold/Light/Medium/Regular `.woff2` (~66 KB each)
- `assets/img/` — `welcome.png` (272,921 B), `sidebar/container.png` (133,527 B)
- `assets/img/agents/` — one PNG per agent (astra, breach, brimstone, chamber, clove,
  cypher, deadlock, …)
- `assets/img/weapons/`, `assets/img/medals/`, `assets/img/ranks/` (`0.png` …),
  `assets/img/maps/` (abyss, piazza, district, summit, glitch, …),
  `assets/img/avatars/` (`unknown.png`), `assets/img/timeline/` (round-timeline icons)
- `assets/icons/` — `IconMouseNormal.png`, `IconMouseOver.png`, `LauncherIcon.ico`

## `plugins/` — 5 native DLLs (811,560 B)

| File | Size | Role |
| --- | --- | --- |
| `Overwolf.Plugins.Valorant.dll` | 9,216 B | native helper used by the custom GEP provider; strings show `getEntitlementsToken`, `accessToken`, `token`, `entitlements`, `subject`, `HttpClient`, `X509Certificate2` — it mints the local Riot entitlements triple |
| `Overwolf.Plugins.Support.dll` | 10,240 B | Overwolf plugin support layer |
| `DiscordRPC.dll` | 83,968 B | Discord Rich Presence transport |
| `discord-rich-presence.dll` | 6,144 B | Discord RPC shim |
| `Newtonsoft.Json.dll` | 701,992 B | JSON.NET used by the C# plugins |

## Totals

| Group | Files | Bytes |
| --- | --- | --- |
| manifest + metadata | 2 | 13,428 |
| windows (HTML) | 10 | 12,076 |
| js (shared) | 24 | 751,359 |
| js/windows (entries) | 10 | 370,456 |
| css | 16 | 164,699 |
| assets | 122 | 3,258,342 |
| plugins | 5 | 811,560 |
| **total** | **189** | **5,381,920 (~5.38 MB)** |
