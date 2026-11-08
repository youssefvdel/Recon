# TRN app — network endpoints

Every endpoint found in `docs/overwolf/captures/opk/extracted/js/**`. Host list from a
full-chunk scan; paths from string literals; headers from the fetch call sites in
`js/Cu_khBDY.js` (Tracker API), `js/windows/BSj0SAG_.js` (Riot Client Service, Socket.IO,
OAuth), `js/windows/*.js` (window-specific).

## Tracker Network API (`api.tracker.network`)

Base config, `js/Cu_khBDY.js` (minified class `r`, method names preserved):

```js
var n = {
  KEY: `<redacted: hardcoded TRN-API-Key>`,
  PROFILE:  `https://api.tracker.network/api/v2/valorant/standard/profile/`,
  MATCHES:  `https://api.tracker.network/api/v2/valorant/standard/matches/`,
  INSIGHTS: `https://api.tracker.network/api/v1/valorant/insights/`,
  SEASONS:  `https://api.tracker.network/api/v1/valorant/db/seasons`,
  GUIDES:   `https://api.tracker.network/api/v1/valorant/guides`,
  BULK:     `https://api.tracker.network/api/v1/valorant/overwolf/ow-bulk-lookup`,
  PRIVACY:  `https://api.tracker.network/api/v1/valorant/privacy/settings`,
  REALTIME: `https://realtime-events.tracker.network`
};
```

| # | Method | URL | Headers | Purpose / response |
| --- | --- | --- | --- | --- |
| 1 | GET | `/api/v2/valorant/standard/profile/{platform}/{name}%23{tag}?source=overwolf-2` | `TRN-API-Key`, `Content-Type: application/json` | Profile page payload: `data.metadata`, `data.segments[]`, `data.segments[].stats.*.value`; `source=web` variant for the website |
| 2 | GET | `/api/v2/valorant/standard/matches/{matchId}` | `TRN-API-Key` | **Match detail — the per-round source** (see `rounds.md`). `data.metadata` + `data.segments[]` |
| 3 | GET | `/api/v2/valorant/standard/matches/{platform}/{name}%23{tag}?type={playlist}&source=overwolf-2[&v=timestamp]` | `TRN-API-Key` | Recent match list for a player/playlist (`fetchRecentMatches`) |
| 4 | GET | `/api/v1/valorant/insights/{agent\|...}?histogram=false` | `TRN-API-Key`, `User-Agent: OverwolfClient` | Global insights; 403/China special-cased to `null` |
| 5 | GET | `/api/v1/valorant/db/seasons` | `TRN-API-Key` | Season catalogue; HTTP 403 → `{isChina: true}` |
| 6 | GET | `/api/v1/valorant/guides?agent={a}&map={m}` | `TRN-API-Key`, `User-Agent: OverwolfClient` | Lineup/guide videos (`data.videoUrl`, `previewImageUrl`, `attributes.agent/ability/map/team/location`, `score`, `views`) |
| 7 | POST | `/api/v1/valorant/overwolf/ow-bulk-lookup` | `TRN-API-Key`, `User-Agent: OverwolfClient` | Lobby batch: body `{phaseId, matchId, playlistId, mapId, players[]}`; returns per-player playlistStats/agentStats/matchHistory/peakRank/isPrivate (`fetchMultipleProfiles`) |
| 8 | PUT | `/api/v1/valorant/privacy/settings` | `Authorization: Verification {token}` | Sets `{isPrivate}` — user profile privacy toggle `setPrivacy` |
| 9 | GET | `/api/v1/valorant/premier/roster/{team}/detailed?region={r}` | `TRN-API-Key` | Premier team roster/stats (`fetchPremierTeamInfo`) |
| 10 | Socket.IO | `wss://realtime-events.tracker.network` | — | `transports: ['websocket','polling']`, `reconnect 10 s ×3`; emits `subscribe` `{eventName, attributes}`, listens `subs.<event>`; observed topic `valorant.profile.updates` |

Reachability: per the Lead's measurements, these hosts answer without the key when the
request carries the Overwolf client fingerprint (UA/origin). **The key and these
private/undocumented routes are off-limits for Recon** — documented here only so we know
what not to call.

## Riot client endpoints used by the app (`js/windows/BSj0SAG_.js`, class `F` + GEP class `he`)

Auth material is local: `Riot Client\Config\lockfile` (port + password) for the local
client, `VALORANT\Saved\Logs\ShooterGame.log` for `CI server version` and the
`glz-(\w+)-1.(\w+).a.pvp.net` region/shard, and `Overwolf.Plugins.Valorant.dll`
(`getEntitlementsToken` → `accessToken`, `token`, `subject`). Every PD/GLZ call sends:

```
Authorization: Bearer {accessToken}
X-Riot-Entitlements-JWT: {token}
X-Riot-ClientPlatform: {base64 platform JSON}
X-Riot-ClientVersion: {release-XX.XX-shipping-…}
```

| Method | URL | Purpose |
| --- | --- | --- |
| GET | `https://glz-{region}-1.{shard}.a.pvp.net/parties/v1/players/{puuid}` | own party ID |
| GET | `https://glz-{region}-1.{shard}.a.pvp.net/parties/v1/parties/{partyId}` | party roster |
| GET | `https://glz-{region}-1.{shard}.a.pvp.net/{pregame\|core-game}/v1/players/{puuid}` | active match ID (`MatchID`) |
| GET | `https://glz-{region}-1.{shard}.a.pvp.net/{pregame\|core-game}/v1/matches/{matchId}` | live match: `Players[]` with `PlayerIdentity` (AccountLevel, HideAccountLevel, Incognito), `SeasonalBadgeInfo` (`CompetitiveTier`, `RankedRating`), `PremierPrestige`, `CharacterID`, party |
| GET | `https://pd.{shard}.a.pvp.net/match-details/v1/matches/{matchId}` | post-match detail (rounds) |
| GET | `https://pd.{shard}.a.pvp.net/match-history/v1/history/{puuid}?queue&startIndex&endIndex` | match list for a puuid (batched `Promise.all`) |
| GET | `https://pd.{shard}.a.pvp.net/mmr/v1/players/{puuid}` | rank/RR per puuid (batched) |

## Overwolf / app services

| Service | URL / API | Purpose |
| --- | --- | --- |
| GEP | `overwolf.games.events.setRequiredFeatures / onNewEvents / onInfoUpdates2 / getInfo` | live game data; features `[me, game_info, match_info, premier_info, career_stats]` |
| GEP status | `https://game-events-status.overwolf.com/{game}_prod.json?v=…` | feature health → green/yellow/red |
| GEP custom provider | local file listener on `ShooterGame.log`; `valorant-plugin` native helper | fallback when default GEP is unavailable |
| OAuth | `overwolf-extension-ipmlnnogholfmdmenfijjifldcpjoecappfccceh://auth/authorize`, `{account}/auth/logout` | account linking for profile/privacy features |
| CDN | `trackercdn.com` (ranks, agents, weapons, medals, maps, avatars, timeline icons), `embed.cloudflarestream.com` (guide videos) | static/UI assets |
| Links | `tracker.gg`, `go.tracker.gg`, `titles.trackercdn.com`, `account.tracker.gg` | deep links, rank names, account pages |
| Analytics | `google-analytics.com`, Sentry (`_sentryDebugIds` in every chunk) | telemetry/crash |

## Notes

- Every request wrapper checks `content-type` and throws the raw body on non-JSON, then
  surfaces `TRN`/`Riot` errors through `notify` — the same error-shape approach Recon uses.
- `source=overwolf-2` vs `source=web` is the only difference between app and website
  calls; the app passes `overwolf-2`.
- Header names: TRN uses `TRN-API-Key`; privacy uses `Authorization: Verification <token>`
  (a logged-in web session token, not the API key).
