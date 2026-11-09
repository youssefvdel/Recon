# Judge — source-truth audit

Second, independent judge (after `qa-verify`). This checks one thing: **does the app say
where each number came from, and does the number match the source a reviewer can call
themselves?** No vibes — every row is a command and an expected shape. Companion to
`docs/architecture/data-sources.md` (capability matrix) and `docs/features/round-timeline.md`.

## 0. Reviewer setup (Windows PC with Riot Client logged in)

```powershell
$lf  = "$env:LOCALAPPDATA\Riot Games\Riot Client\Config\lockfile"
$port,$pw = (Get-Content $lf -Raw).Trim().Split(':')[2,3]
$t   = & curl.exe -sk -u "riot:$pw" "https://127.0.0.1:$port/entitlements/v1/token" | ConvertFrom-Json
$log = Get-ChildItem "$env:LOCALAPPDATA\VALORANT\Saved\Logs" -Filter ShooterGame.log | Select -Last 1
$shard = [regex]::Match((Get-Content $log -Raw), 'glz-[a-z0-9]+-1\.([a-z0-9]+)\.a\.pvp\.net').Groups[1].Value
$plat  = 'ew0KCSJwbGF0Zm9ybVR5cGUiOiAiUEMiLA0KCSJwbGF0Zm9ybU9TIjogIldpbmRvd3MiLA0KCSJwbGF0Zm9ybU9TVmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwNCgkicGxhdGZvcm1DaGlwc2V0IjogIlVua25vd24iDQp9'
$ver   = [regex]::Match((Get-Content $log -Raw), 'CI server version: (\S+)').Groups[1].Value
$H = @{ Authorization = "Bearer $($t.accessToken)"; 'X-Riot-Entitlements-JWT' = $t.token;
        'X-Riot-ClientPlatform' = $plat; 'X-Riot-ClientVersion' = $ver }
function Riot($url) { & curl.exe -s -H "Authorization: $($H.Authorization)" -H "X-Riot-Entitlements-JWT: $($H.'X-Riot-Entitlements-JWT')" -H "X-Riot-ClientPlatform: $plat" -H "X-Riot-ClientVersion: $ver" $url }
```

The reviewer never trusts the app's cache: every value below is fetched fresh with the
reviewer's own token, then compared with what the UI shows (screenshot or DOM text).

## 1. Field truth table

| Field (UI) | Authoritative source | Reviewer command | Expected shape |
| --- | --- | --- | --- |
| Rank emblem — board, mini, overlay tooltip | Riot `mmr` | `Riot "https://pd.$shard.a.pvp.net/mmr/v1/players/<PUUID>"` → `.LatestCompetitiveUpdate.TierAfterUpdate` (or current-season `.QueueSkills.competitive.SeasonalInfoBySeasonID[<season>].CompetitiveTier`) | integer 0–27; `0` = Unranked only if Riot itself says 0 |
| RR | Riot `mmr` | same payload → current-season `.RankedRating` (fallback `.LatestCompetitiveUpdate.RankedRatingAfterUpdate`) | integer 0–100 |
| Peak | Riot `mmr` | max `CompetitiveTier` across `.SeasonalInfoBySeasonID[*]` | integer; never lower than current tier |
| Level | Riot GLZ match payload | `Riot "https://glz-<region>-1.$shard.a.pvp.net/core-game/v1/matches/<matchId>"` → `.Players[].PlayerIdentity.AccountLevel` | integer; absent → dash, never 0 |
| K/D | computed from Riot `match-details` | `.players[]` totals over the act window (`sum(kills)/sum(deaths)`) | 2-dp number; `deaths=0` → null/dash |
| ACS | computed from Riot `match-details` | `sum(players[].stats.score)/sum(roundsPlayed)` | 1-dp number; 0 rounds → null |
| Win % | Riot `mmr` or `roundResults` | current-season `NumberOfWins/NumberOfGames` (or rounds won/lost) | integer 0–100 |
| HS % | computed from Riot `match-details` | `sum(damage[].headshots)/sum(headshots+bodyshots+legshots)` | integer 0–100; no hits → dash |
| Round timeline (kills/deaths/assists/damage/economy/plants) | Riot `match-details` | `.roundResults[]` → per round `playerStats[].kills[]`, `damage[]`, `economy`, `bombPlanter/plantSite/plantRoundTime/defuseRoundTime` | one entry per `roundNum`; absent fields omitted, never zero-filled |
| Live score / round / phase / map | local presences | `Riot "https://127.0.0.1:$port/chat/v4/presences"` → own `private` base64 → `matchPresenceData` + `partyOwnerMatchScore*` | ints/strings; match only while `sessionLoopState` INGAME/PREGAME |
| Party grouping | GLZ match or presences | `.Players[].partyId` (core-game) or presence `private` `partyId` | equal ids ⇒ same party |
| Incognito | GLZ match payload | `.Players[].PlayerIdentity.Incognito` | boolean; badge only when true |
| Tracker appendix (TRN K/D, win %, HS %, ACS, score) | TRN profile | DevTools network: `GET https://api.tracker.network/api/v2/valorant/standard/profile/riot/<Name%23Tag>?source=overwolf-2` | `data.segments[]`; value must equal the matching segment stat |

**How to prove the app used it:** (a) direct fields — displayed value equals the reviewer's
fresh call within rounding; (b) computed fields — recompute with the formula above from the
same raw payload and match; (c) any field whose source call fails must render the §3
behaviour, not a number.

## 2. Tracker appendix rules (all four must hold)

1. **`as of` stamp present.** Every TRN-derived number carries `as of <date> <time>`
   (`Overview.tsx:722`, label from `trnFetchedAt`). Reviewer: compare the stamp with the
   cached `fetchedAt` — must match within one minute.
2. **Hidden past 7 days.** `TRN_STALE_MS = 7 days` (`Overview.tsx:157`). Data older than
   that is hidden, not shown greyed. Reviewer: age the cached entry in devtools
   (`localStorage` TRN snapshot), reload, confirm the appendix disappears.
3. **Private lock only from a non-public `metadata.privacy`** (or HTTP 451). The shipped
   app treats `metadata.privacy` values `public` / `ranked` as public and **anything else
   as private** (`Cu_khBDY.js` in `docs/overwolf/captures/`). Reviewer: open the profile
   response, read `data.metadata.privacy`; lock may appear only when it is not
   `public`/`ranked`.
4. **404 is "no profile", never private.** 404 → dash with
   `Tracker has no profile for this account`; lock only for 451/private. Reviewer: request a
   never-tracked account, confirm dash + missing tooltip, and confirm
   `LIVE_PRIVATE_TIP` never appears. (`LiveMatchView.tsx:56,60-61,620-635`.)

TRN requests must carry `?source=overwolf-2`; the key is decorative and the UA is the gate
(`docs/architecture/data-sources.md` §2). Captcha/unavailable ⇒ "Tracker unavailable",
never private.

## 3. Failure semantics

- **Riot error ⇒ stale or error, never a number.** Riot 4xx/5xx bodies are
  `{httpStatus, errorCode, message}`; the UI must keep the last known value marked stale
  (with its `as of`) or show the error banner. A zero, "Unrated", or a made-up tier on an
  error is a **FAIL**.
- **"Unranked" only from Riot.** Allowed only when `mmr` returns tier 0 with no games; never
  on 403/404/timeout.
- **Partial act window ⇒ "not computed".** `actState` must be one of
  `too-long | incomplete | timeout | local-failed` — never a number over a partial window.
- **Missing field ⇒ dash + reason.** Zero is a number only when the source reports zero.
- **TRN failure ≠ private.** 404 → "no profile"; captcha/429 → unavailable; only
  451/non-public privacy → lock.

## 4. Pass/fail procedure

1. Start a match or open a tracked match; capture board + overlay values.
2. Run the reviewer commands for the same PUUID/match; compare row by row (§1).
3. Recompute K/D, ACS, HS %, win % from the raw JSON; compare.
4. Check §2 rules 1–4 with a public account, a private one, and an untracked one.
5. Close the Riot Client mid-view: values must go stale-marked or error — never zero.
6. **PASS** only if every row matches and every failure follows §3. One fabricated value,
   one private badge from a 404, or one stale value past 7 days = **FAIL**.
