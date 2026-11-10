# alpha28 — toast, window floor, legend

Build `v0.5.0-alpha28` (sha256 `21dbcb19…`), Riot at the login window (signed out).

## Toast — PASS

`NoticeToast` is `fixed bottom-6 right-6` (24 px). In a 1360×850 viewport the measured rect was
(984,761)–(1336,826); `main` stayed at top 56 / left 288 for the toast's whole life — **no layout
shift**. Samples every 500 ms show it present through 5.55 s and gone at **6.06 s** (TOAST_MS 6000).
Dedupe is by reason (`AppToast.bannerReason` + `seenReason`/`dismissedReason`); a second refresh with
the same signed-out reason after dismissal did **not** re-fire. An age-only change cannot re-fire
because the key is the reason, not the message text.

## Window floor — PASS

`src-tauri/tauri.conf.json` minWidth 1360 / minHeight 850; runtime content is exactly 1360×850.
Interactive-session drag test (scheduled task, since SSH cannot enumerate the user's windows):
outer rect 1376×859 → dragged the bottom-right border inward 12 steps → **1376×859 unchanged**.
Caveat: the bridge's programmatic `resize_window` can force 1200×700 (`set_size` bypasses
`WM_GETMINMAXINFO`), but a user drag refuses. Do not judge the floor with the bridge command.

## Legend — PASS

Matches legend: `4 not cached = no match detail on disk yet · open that match to load its scoreboard`;
rows read `NOT CACHED`; zero occurrences of "not fetched". Screenshot `a28-legend.png`.

## Modal baseline (before alpha29)

`a28-modal.png` and `a28-modal-timeline.png` captured. Modal fixes are already in main
(`bc33b76` verdict hero / sticky header / single round rail / no mini-strip) but alpha29 is not
published yet; capture the same two frames after installing it.
