# Recon audits — 2026-11-07

Four read-only audits, one per surface. Every finding carries `file:line`, a
fix, an effort (S < 2 h, M ≈ 0.5–1 day, L > 1 day) and a value.

| File | Owns |
|---|---|
| [ui.md](ui.md) | App UI: states, hierarchy, consistency, accessibility, motion |
| [overlay.md](overlay.md) | In-game overlay/HUD: input safety, click-through, DPI, frame cost |
| [perf.md](perf.md) | Idle cost, bundle, memory, disk caches, in-game overhead |
| [ux-gaps.md](ux-gaps.md) | First run, dead ends, settings, recovery, stale copy |

Nothing was reproduced live — the app is Windows-only and the audit host is
Linux. Evidence is source, Tailwind tokens, a local bundle build, and the
repo's own recorded `perf.rs` measurements. Verdicts that need a real Windows
box are marked VERIFY in the individual files.

## Status: applied

All findings in this folder were fixed across three waves on `main`:

- `5ba5158` wave 1 — overlay input fail-safe, WS_EX_LAYERED and every CSS blur
  removed, alpha layer only when it has content, in-game drain fixed, TRN cache
  capped + swept, proxy TTL 60 s, account-switch guard, bundle 1012 -> 648 kB.
- `f474f7f` wave 2 — heartbeat opt-in (privacy claim true), stale tracker.gg copy
  gone, honest stat cells, modal/tooltip/tab/switch accessibility, Riot-client
  status surfaced, text floor, signed automated releases.
- `18e0f95` wave 3 — the last blur sites, Overview's real unavailable states with
  retry, shared StatValue across views, overlay notice reader, installer
  Authenticode-signed before the updater signature is regenerated.

Anything still open is called out in the individual files (VERIFY items that need
a Windows box, and the two deliberately-deferred items: the healthy-client
profile-fetch spinner, and the HUD keeping its 2-decimal K/D precision).

## Ranked cross-audit shortlist

Value per unit effort, highest first. "Why now" is the reason it outranks the
rest of its file.

| # | Finding | Area | Effort | Why now |
|---|---|---|---|---|
| 1 | Edit mode has no fail-safe: a dead webview or refused focus leaves a fullscreen topmost window eating every click | overlay | S | Worst possible failure for an in-game app |
| 2 | "Nothing leaves this PC" is false — every launch POSTs Riot ID + version to a hardcoded IP, and the consent popup that used to gate it was removed | ux | S | The privacy claim is the product's main trust signal |
| 3 | `WS_EX_LAYERED` on the click-through path and 13 `backdrop-blur` sites, 4 of them on in-play HUD plates | overlay | S | Both are explicitly banned by this repo's own rules; both cost frames over the game |
| 4 | Account switch kills Riot Client and VALORANT mid-match with no live-match guard (the updater already has one) | ux | S | Data loss the user blames on the game |
| 5 | The new local-Riot act scan multiplies the in-game drain window ~25× (up to ~530 local GETs while VALORANT is foreground) | perf | M | Regression from the tracker.gg replacement; only path that spends work in-game |
| 6 | The dead TRN cache (~67 MB) is probed on every refresh and never shrinks — eviction only runs on write | perf | S | Disk + wasted probes forever, for a source that is gone |
| 7 | Missing data renders as a fake `0` or an unexplained dash that means "never fetched" | ui | S | Contradicts the app's own read-back-or-mark-unverified rule |
| 8 | The hidden WebView2 TRN proxy is created eagerly (~100 MB, 5.6 % of 12 cores measured) though TRN is now a cold fallback | perf | S | Largest single memory line item for a path that rarely runs |
| 9 | The 1,012 kB main chunk ships 18 statically-imported views, zero `lazy()` | perf | M | Boot time on every launch, including boot-to-tray |
| 10 | Every Framer animation ignores `prefers-reduced-motion` | ui | S | Accessibility floor, cheap to add |

## Also worth scheduling

- Tray-idle 2 s poll never stops (`document.hidden` is always false in a Tauri window) — perf #4
- Modals are invisible to assistive tech and let Tab escape behind them — ui #4
- Stale tracker.gg copy still promises a source that died 2026-11-02 — ux #4
- Synthetic "Tracker Rating Score" renders as measured for every match — ux #9
- The updater has no automated publisher; a missing `.sig` silently strands users — ux #10

## What is already good (do not regress)

Named in `ui.md` (colour tokens, focus handling on primary actions, empty-state
illustrations), `perf.md` (bounded caches, dev-only perf probe, logger ring) and
`overlay.md` (click-through flag semantics, hotkey plumbing). The audits were
written to protect those while fixing the rest.
