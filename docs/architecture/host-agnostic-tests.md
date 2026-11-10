# Host-agnostic backend tests

The full `src-tauri` crate cannot build on this Linux box: `cargo check` fails in
`libdbus-sys` (pkg-config cannot find dbus), and GTK/WebKitGTK are absent. That
means no `#[cfg(test)]` module inside the crate can run without a Windows
machine — including the pure ones.

`src-tauri/pure` exists to fix exactly that. It is a tiny crate that includes the
production files **by path** (`#[path = "../../src/..."]`), so tests run against
the real code and nothing is forked or copied. Anything importing
`windows`/`tauri` stays out.

```bash
cd src-tauri/pure && cargo test        # 24 tests, no PC, no Tauri
```

## TypeScript pure modules (`bun test`)

`bun test tests/` — 16 tests, no Tauri, no browser, no Windows.

| Production module | Tests | What the fixtures prove |
| --- | --- | --- |
| `src/utils/crosshairCodec.ts` | 11 | builder refuses non-object docs, >2 MB docs and an empty/failed deflate; emits the `Ares.PlayerSettings` envelope; deterministic byte-for-byte; deflate→inflate round-trip including non-ASCII; canonical compare is key-order independent but catches changed values and reordered arrays; a truncated payload fails loudly; write contract `{ data: string }` or throw |
| `src/sources/storefront.ts` | 5 | a well-formed shop parses; a Riot error envelope is rejected (the empty-shop bug); payloads without any shop section are rejected; a missing `SkinsPanelLayout` is accepted only when another section is present; scalar/array shapes rejected |

`crosshair.ts` and `riot.ts` import these modules at their call sites; the pure
modules import nothing, so no Tauri or DOM mocking is involved.

## Covered (tested here, all passing)

| Production file | Tests | What the fixtures prove |
| --- | --- | --- |
| `src/perf/model.rs` | 9 | CPU % from a real 100 ns delta (3 359 ms / 5 s / 12 cores = 5.598 %), PID-pair delta (new/exited PIDs), census omitted counts, RSS MiB, basis naming (clean vs Mixed), tree rollups, summarize empty/last, ring eviction, pause predicate |
| `src/trn_proxy/ceiling.rs` | 5 | lobby cap at 30 rolls per match, hour cap at 900, window roll at 1 h, unkeyed requests hour-only, refunds saturate and never touch another lobby, refund allowlist (`TRN_CAPTCHA_REQUIRED` / `EDGE_*` vs `HTTP 429` / `TRN_BUDGET`) |
| `src/trn_cache/paths.rs` + `constants.rs` | 7 | path allowlist incl. the 300/301 boundary, published FNV-1a 64 vector (`hello` → `a430d84680aabd0b`), 16-hex stable keys, `entry_path` cannot escape the cache dir, header round-trip with spaces, garbage rejection, `read_header` on real temp files |
| `src/trn_proxy/trace.rs` | 2 | bounded ring eviction, incremental `trace_since` head/lines/missed semantics, zero cap |
| `src/trn_http_rules.rs` | 3 | host allowlist (exact host only: suffix/prefix/userinfo tricks, scheme-relative and absolute redirect targets, empty host, port), path allowlist (scheme smuggling, `//`, `.`/`..` segments, query pass-through that cannot smuggle a scheme or traversal, whitespace, empty, 300 boundary), status map (2xx → body, 451/404/429 → TS keys, 403/500/302 → `HTTP n`) |
| `src/updater_version.rs` | 10 | prerelease ordering (`1.0.0-beta < 1.0.0`), natural `alpha9 < alpha10` (string compare would invert), equal/downgrade never upgrades, malformed tags never upgrade, manifest picker takes the highest not the first, stale release-list ∪ `releases/latest`, channel classification, stable channel never fetches, alpha fallback with no usable tag |

`src/perf/model.rs` is the strongest case: it is the memory/CPU maths the
dashboard renders, and it is a pure function of its arguments.

## Blocked on Linux (and by what)

| Module | Blocker |
| --- | --- |
| `calculator.rs` | `GetSystemMetrics` (Win32) |
| `display/`, `gpu.rs`, `custom_res.rs` | Win32 display/registry APIs |
| `game_config.rs` | Windows registry |
| `window_manager.rs`, `shortcuts.rs`, `space_spam.rs` | Win32 window/input APIs |
| `accounts.rs` | Windows registry + Tauri app paths |
| `state.rs` | `crate::display` (Win32) |
| `trn_cache/{store,read,sweep}.rs` | `tauri::AppHandle` for app paths (the path/header layer above is covered) |
| `trn_proxy/{window,fetch,...}.rs` | WebView2 / Tauri window runtime |
| `perf/sampler.rs` | Win32 PDH / process APIs (the model above is the pure half) |

## Not covered yet

- **TypeScript pure logic** — the crosshair payload builder, deflate/inflate +
  canonical comparison, and the storefront response validation are host-agnostic
  by nature but live in modules that import Tauri IPC; testing them needs a small
  extraction or `bun test` with the transport mocked. Not done in this pass.
- **`updater.rs` version maths** — pure and valuable (`alpha9 < alpha10` natural
  ordering, channel endpoint selection), blocked only by the module's Tauri
  imports. Extraction is a small, additive refactor.

## CI note

This crate is deliberately **not** a workspace member and is not part of the
Windows build. A Linux CI job can run it with:

```bash
cargo test --manifest-path src-tauri/pure/Cargo.toml
```

No system packages, no Windows target, no secrets.
