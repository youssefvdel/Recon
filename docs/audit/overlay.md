# Overlay audit — input safety, frame cost, and first-party feel

Read-only audit of the in-game overlay (`overlay` window). Branch `fix/trn-captcha`.
Method: source reading only. No build, no run, no PC access. Every claim below is
traceable to the cited line; anything that needs a machine to confirm is marked
**VERIFY**.

Files read: `src/components/OverlayView.tsx`, `src/components/OverlayCrosshair.tsx`,
`src-tauri/src/window_manager.rs`, `src-tauri/src/lib.rs` (overlay commands, boot
path, daemons), `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`,
`src/components/AppSettingsView.tsx`, `src/components/DevDashboard.tsx`,
`src/hooks/useTrackerData.ts`, `AGENTS.md`, `README.md`.

The overlay is one full-screen, always-on-top, transparent WebView2 window pinned
to the VALORANT window rect (`src-tauri/src/window_manager.rs:724`). Everything
below is a consequence of that shape.

---

## Ranked summary

| # | Finding | Effort | Value |
|---|---------|--------|-------|
| 1 | Edit mode has no fail-safe — the overlay can keep eating every click | S | High |
| 2 | `WS_EX_LAYERED` is set on the click-through path (banned; defeats DWM direct flip) | S | High |
| 3 | `backdrop-filter` blur on HUD plates over the game (banned; per-frame GPU cost) | S | High |
| 4 | Full-screen composite for the whole match while rendering nothing | M | High |
| 5 | Entering edit mode steals the foreground from VALORANT | S | Med-High |
| 6 | Widget positions are raw CSS px tied to one screen; DPI/monitor changes move the HUD | M | Med |
| 7 | Exclusive fullscreen: HUD silently invisible, no detection or warning | S | Med |
| 8 | A blind 2 s tick drives show/hide/align — up to 2 s of nothing after alt-tab | S | Med |
| 9 | Dead repaint + dead config event: the white-flash mitigation is a no-op | S | Low-Med |
| 10 | Every overlay failure is swallowed — the toggle just does nothing | S | Low-Med |

---

## 1. Edit mode has no fail-safe — the overlay can keep eating every click

**Symptom.** Player opens HUD edit mode. The overlay becomes
`WS_EX_TOPMOST`, full-screen, and no longer click-through. That state is owned by
one process-global flag. If the flag is ever left set while the user is not in the
overlay, every mouse click over the game lands on a transparent window and dies.
No cursor change, no error, no visible exit.

How it can be left set:

- The only exit from the UI is a DOM `keydown` listener inside the overlay webview
  (`src/components/OverlayView.tsx:739-746`). If that webview dies or navigates,
  Escape stops working and the on-screen Lock button stops existing. The HWND
  survives and keeps its non-click-through styles.
- Escape needs keyboard focus. Entering edit mode calls `SetForegroundWindow`
  (`src-tauri/src/window_manager.rs:793`) and `set_focus`
  (`src-tauri/src/lib.rs:393`) and ignores both results (`let _ =`). A refused
  focus grab leaves Escape dead from the first frame.
- The auto-overlay daemon — the one thing that could heal a bad state — skips
  entirely while the flag is set (`src-tauri/src/lib.rs:1026-1047`).
- Every style call in the toggle ignores its error (`src-tauri/src/lib.rs:398`,
  `:407`). The IPC returns `Ok` even when the Win32 call failed, so the settings
  UI flips to "Locked" while the window still swallows clicks.

Bounded by process exit: killing Recon from the tray clears the static flag. That
is the only recovery today.

**Evidence.** `src-tauri/src/lib.rs:24` (the flag), `:387` (only writer),
`:1026-1047` (daemon skips), `:398`/`:407` (errors dropped),
`src-tauri/src/window_manager.rs:650-653` (hit-test gate), `:793` (focus steal),
`src/components/OverlayView.tsx:739-746` (Esc only).

**Fix.** Three cheap belts:
1. Register a global hotkey (Tauri `global-shortcut`, e.g. `Ctrl+Shift+H`) that
   calls `set_overlay_edit_mode(false)` without needing WebView focus.
2. Watchdog in the daemon: if the flag is set and no `WM_MOUSEMOVE` has reached
   the overlay for 90 s, force the flag off and re-apply click-through.
3. On overlay webview load failure / process-gone, force
   `set_overlay_edit_mode(false)`. Also stop swallowing the Win32 errors in
   `set_overlay_edit_mode`.

**Effort S · Value High.** This is the only finding that can make the app feel
broken rather than imperfect.

---

## 2. `WS_EX_LAYERED` is set on the click-through path

**Symptom.** The overlay is a full-screen topmost window over a borderless
fullscreen game. It is marked layered while click-through
(`src-tauri/src/window_manager.rs:712`), which forces the DWM to composite it
instead of promoting the game to independent flip / MPO. Expect a measurable
frame-time cost and variance every match — not one drop, a tax for 40 minutes.

It is also the repo's own rule, twice over:

- `AGENTS.md`: "DirectComposition GPU pipeline. Do not use `WS_EX_LAYERED` or CSS
  backdrop blur."
- `window_manager.rs:770` says it in the code itself: *"DO NOT set WS_EX_LAYERED
  (breaks DirectComposition)"* — written inside `set_overlay_editable`, 58 lines
  below the click-through path that sets it happily.

It is not needed. Click-through is already guaranteed twice: `WS_EX_TRANSPARENT`
(`:712`) and the `WM_NCHITTEST → HTTRANSPARENT` subclass (`:649-653`). Layered is
the legacy per-pixel-alpha flag; transparency here comes from
`transparent: true` + DirectComposition (`tauri.conf.json` overlay window).

**Evidence.** `src-tauri/src/window_manager.rs:712` (sets it), `:770` (forbids it),
`:805-813` (`overlay_clickthrough_missing` *requires* it, so it must be updated in
the same change), `:391` (the debug windowed path sets it too), `AGENTS.md:57`.

**Fix.** Drop `0x00080000` from the click-through branch and from
`overlay_clickthrough_missing`'s check; keep `TRANSPARENT` + `NOACTIVATE`. Then
re-test the white-flash cases this flag was probably added to paper over.
**VERIFY** with PresentMon or GPUView before and after: `PresentMode` should go
from Composed to Hardware Composed Independent Flip with the overlay shown.

**Effort S · Value High.** Biggest possible single win on frame cost, and it
removes a documented landmine.

---

## 3. `backdrop-filter` blur on HUD plates over the game

**Symptom.** Every HUD plate is `bg-m3-surface-container/[0.75]` **plus**
`backdrop-blur-xl` (`24px`). A backdrop filter has to sample and blur what is
behind the window — here, three live game frames per blur region, every frame the
window is composited. On a 75 % opaque plate the visual difference is close to
zero. The cost is not.

This is the second half of the `AGENTS.md` rule above, and it is the known source
of the transparent-WebView2 white/black box artifacts that this file already works
around elsewhere (`redraw_all` at `window_manager.rs:429`, the repaint timers in
`OverlayView.tsx`).

13 occurrences. In-play chrome, not just edit mode:

- `src/components/OverlayView.tsx:1379` — match status card (the Tab-peek panel)
- `:1537` — agent-select / pregame panel
- `:1666` — top-agents card
- `:2010` — pre-pick reminder badge (`backdrop-blur-2xl`, queue screen)
- `:971`, `:1026`, `:1344`, `:1502`, `:1630`, `:1986` — edit-mode chrome
- `src/components/UnifiedStretch.tsx:802` — modal, not overlay, listed for the rule

**Fix.** Delete `backdrop-blur-*` and raise the plate to `/85`-`/90`, or use a
`bg-gradient-to-b` plate. Compare a screenshot before/after in edit mode; if the
plate reads worse, that is a taste call, not a reason to keep the blur.

**Effort S · Value High.** One-line deletion per site, immediately measurable GPU
saving on the surface that matters most.

---

## 4. Full-screen composite for the whole match while rendering nothing

**Symptom.** During a round the overlay draws one of two things: the Tab-peek
panel while Tab is physically held, and (opt-in) the crosshair. Nothing else —
`showScorePanel`/`showPregamePanel`/`topAgentsVisible` are all false outside
Tab-hold in `coregame` (`src/components/OverlayView.tsx:875-876`, `:909-914`).
The other ~95 % of the match the window is a full-screen alpha layer over the
game doing nothing, composited every frame at the monitor refresh rate.

The comment in the daemon knows the shape of this ("at 260Hz that vsync churn
alone is several percent CPU", `src-tauri/src/lib.rs:1010-1014`) and solved it
only for the *background* case — hide when VALORANT is not foreground. The
foreground case is left running all game.

**Evidence.** `src-tauri/src/lib.rs:1056-1083` (show for the whole foreground
lifetime), `src-tauri/src/window_manager.rs:724-736` (window = full game rect),
`src/components/OverlayView.tsx:875-877`, `:909-914` (render gates).

**Fix.** During `coregame`, drive visibility from the Tab state Rust already
reads: `is_tab_down()` (`src-tauri/src/window_manager.rs:623`) polled at 50-100 ms
in the daemon, show on down / hide ~200 ms after up, and always show when the
crosshair is enabled. Keep the window created and pre-styled so a show is one
`SetWindowPos`. Do **not** per-frame show/hide from JS — that reintroduces the
150 ms IPC latency as visible flicker.

**VERIFY** first: if DWM keeps a cached surface when nothing invalidates, the
real saving is smaller than it looks. Measure with the overlay shown idle vs
hidden, same scene.

**Effort M · Value High** if the measurement backs it, otherwise Medium.

---

## 5. Entering edit mode steals the foreground from VALORANT

**Symptom.** Player opens HUD edit while the game is running. Windows deactivates
VALORANT: borderless mode loses keyboard focus mid-drag, and the game paints its
top strip white until refocused. Exactly the failure the function's own comment
predicts.

The comment at `src-tauri/src/window_manager.rs:745-749` says NOACTIVATE stays on
because "stealing the foreground deactivates Valorant, which blanks its top strip
to pure white until refocused", and that drag/click do not need activation. Four
lines later the function calls `SetForegroundWindow(hwnd)` (`:793`), after
`lib.rs:393` already called `set_focus()`. The comment and the code disagree; the
code wins.

Related landmine: `set_overlay_clickthrough(false)` also calls `window.set_focus()`
(`src-tauri/src/lib.rs:376-378`), so any future caller of that path steals focus
from the game too.

**Fix.** Remove `SetForegroundWindow`/`set_focus` from the edit-mode path and keep
`WS_EX_NOACTIVATE`. Esc is then dead, which is fine — fix it with the global
hotkey from finding 1, which works without focus. Exit stays on the on-screen
Lock button, as the comment intends.

**Effort S · Value Med-High.** Cheap, visible, and removes a self-documenting
contradiction.

---

## 6. Widget positions are raw CSS px tied to one screen

**Symptom.** Defaults are literal pixel coordinates captured for a 2088×1440
screen (`src/components/OverlayView.tsx:62-96`) — 1.45:1, the stretched
resolution. Dragging saves raw CSS px (`:802-812`), clamped to
`window.innerWidth` (`:778-781`).

Consequences:

- On a native 1920×1080 screen the "exact coordinates" block is used verbatim
  (the guard is `w <= 2088`), so widgets land where they were tuned for a
  different aspect ratio.
- Under 125 %/150 % Windows scaling, WebView2 CSS px ≠ physical px, so every
  saved position shifts by the scale ratio. There is no `devicePixelRatio` or
  `scaleFactor` read anywhere in the overlay path.
- The config is global. Pin the overlay to monitor 2
  (`src-tauri/src/lib.rs:775-782`) and the widgets keep monitor 1's coordinates.
- `overlay_target_rect` (`window_manager.rs:546-551`) can move the window between
  monitors at 2 s notice; positions do not follow.

**Fix.** Persist positions as fractions of the window (`x / innerWidth`,
`y / innerHeight`) plus the scale they were authored at, and rehydrate as
`fraction × current innerWidth × currentScale`. Cheaper variant if that is too
much: key the stored config by `` `${monitor}|${w}x${h}` `` and keep one layout
per setup.

**Effort M · Value Med.** The HUD is hand-placed, so this reads as "janky" rather
than broken — but it lands on every second monitor and every scaled laptop.

---

## 7. Exclusive fullscreen: HUD silently invisible, no detection or warning

**Symptom.** In exclusive fullscreen the game owns the swapchain and DWM does not
compose over it. The overlay is shown, positioned to the game rect, and never
appears. The player sees nothing and gets no explanation. Showing a topmost
window over an exclusive-mode game can also force a mode switch / minimize it,
which is worse than nothing.

Nothing in the overlay path reads the game's display mode. `is_window_borderless_fullscreen`
exists (`src-tauri/src/window_manager.rs:199-231`) but is only used by the
auto-borderless daemon (`src-tauri/src/lib.rs:979`). No overlay copy anywhere
mentions borderless; a grep for "borderless" in `src/components/*.tsx` returns
only the stretch/switcher views.

**Fix.** On `show_overlay`, if the game window is not borderless-fullscreen and
its rect is not the monitor rect, emit a one-shot toast + row in Settings:
"HUD needs borderless. Run Resolution Switch → Borderless." If the user already
opted into auto-borderless, call `make_borderless` first and re-show.

**Effort S · Value Med.** Turns "the overlay is broken" into a known limitation
with a button.

---

## 8. A blind 2 s tick drives show/hide/align

**Symptom.** After alt-tab back to VALORANT, the HUD can take up to 2 s to
reappear — at agent select that is a real chunk of the pick window. A resolution
change can leave the overlay mis-sized for the same 2 s. Every tick also does a
full `EnumWindows` pass (`find_valorant_game_window`, `lib.rs:1048`) and, while
visible, a second one plus a monitor enumeration inside
`align_overlay_to_valorant` (`:1087`, `window_manager.rs:546-551`).

**Evidence.** `src-tauri/src/lib.rs:1025` (2000 ms sleep), `:1078-1095`
(decision + align), `window_manager.rs:40-49` (enumeration cost).

**Fix.** Replace the foreground half with `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)`
(or a 250 ms tick gated on "game process alive"), and cache the game HWND instead
of re-enumerating every pass. Keep the 2 s tick as the slow backstop.

**Effort S-M · Value Med.** Perceived as "the HUD feels slow to come back", which
is exactly the first-party gap.

---

## 9. Dead repaint + dead config event

**Symptom.** `forceRepaint` is an empty function
(`src/components/OverlayView.tsx:585`). It is still scheduled in four places
(`:594`, `:597`, `:613`, `:935`) with comments explaining what it repaints. It
repaints nothing. Either the white-flash problem it was written for is back and
nobody noticed, or it is four timers and a stored callback for nothing.

Same class: the overlay listens for `overlay-config-changed` (`:599-601`) and
nothing in the repo ever emits it — grep finds only this listener and a debug
event-name list in `DevDashboard.tsx:1402`. Any config pushed from the main window
is dropped silently.

**Fix.** Delete `forceRepaint` and its four call sites, or restore it
(`rootRef.current.style.opacity` toggle / `webview.relayout()`); delete the dead
listener, or emit the event from `saveConfig`'s Rust side. Dead code that
documents a mitigation is worse than no code: the next reader will assume the
flash is handled.

**Effort S · Value Low-Med.**

---

## 10. Every overlay failure is swallowed

**Symptom.** Click "Show HUD" when the overlay window failed to create (WebView2
missing, window config rejected): nothing happens. `show_overlay` returns
`Err("Overlay window not found")` (`src-tauri/src/lib.rs:352`) and the caller
catches and drops it — `AppSettingsView.tsx:367-386`, both handlers end in
`catch {}`. Same for every Win32 style call (`let _ =` throughout
`lib.rs:337-435`).

The player's mental model becomes "the overlay button is broken", with no log
line, no toast, no state.

**Fix.** Surface the error in the settings toast (the view already has `setError`
and a toast pattern) and log one line per failure via the existing `log::` calls.
During boot, if `get_webview_window("overlay")` is `None`, disable the overlay
toggles with the reason instead of letting them fail silently.

**Effort S · Value Low-Med.**

---

## What is already right — do not regress

- `WM_NCCALCSIZE`/`WM_NCPAINT`/`WM_ERASEBKGND` subclass
  (`window_manager.rs:627-672`) is the correct way to kill the ghost frame.
- `HTTRANSPARENT` from `WM_NCHITTEST` is the right click-through mechanism; it is
  the layer that should stay after finding 2 removes `WS_EX_LAYERED`.
- No `SWP_SHOWWINDOW` in `align_overlay_to_valorant`/`setup_overlay_window`
  (`:604`, `:728`): visibility is owned by `show()`/`hide()`. That discipline is
  exactly why the daemon cannot un-hide a hidden overlay.
- Hide-while-background (`lib.rs:1056-1083`) is a real win, keep it.
- Pinned-monitor setting (`window_manager.rs:508-551`) is the right shape; only
  the widget coordinates fail to follow it (finding 6).
- `overlay_clickthrough_missing` as a self-heal predicate is a good idea; only
  its LAYERED half is wrong.

## Open questions for a real Windows box

1. Does `WS_EX_LAYERED` on this window actually drop the game off independent
   flip? (PresentMon, overlay shown vs hidden — cheap to prove, decides 2's rank.)
2. How much of the per-frame cost survives with the blur removed but the window
   still visible? (Decides whether 4 is worth the daemon change.)
3. Does entering edit mode really white-strip the game today, or did the newer
   `strip_all_dwm_borders` make it cosmetic? (Decides 5's urgency.)
4. What does `innerWidth` report on a 1440p monitor at 150 % with the overlay
   sized to the game rect? (Confirms 6's mechanism.)
