# Embedded WebView2 runtime

Recon ships its own WebView2 fixed-version runtime, so it does not depend on the
machine having one. This file records how it is obtained, packaged, and the two
traps that cost a shipped release.

## What ships

| | |
|---|---|
| Source | Microsoft's official **fixed version runtime** CAB |
| Version | **157.0.4341.42** (pinned in `scripts/fetch-webview2.mjs`) |
| Download | 310,801,569 B — `sha256 cedaf8f3d12202c8803bdbae727b01c1be34540b78e8f0a10c6b401c2a8be97d` |
| Unpacked | 257 files, ~679 MB, `msedge.dll` = 357,748,040 B |
| Location | `src-tauri/webview2-runtime/` (git-ignored) |
| Licence | redistributable — Microsoft documents the fixed-version runtime as one to ship inside the app, unmodified |

Fetched by `bun scripts/fetch-webview2.mjs`: it resolves nothing at build time
(the URL and hash are pinned), verifies the CAB hash, extracts it, and refuses
to continue unless every required file is present and the right size.

## Trap 1 — the NuGet package is not a runtime

`webview2.runtime.x64` on NuGet is a **third-party repack** (author `ProKn1fe`).
It carries 56 files where Microsoft's CAB has 257. It ships `msedge.dll.sig`
(1.4 KB) but **not `msedge.dll`** (357 MB) — the engine itself.

WebView2 then fails with:

> Could not find the WebView2 Runtime. Make sure it is installed or download it
> from https://developer.microsoft.com/microsoft-edge/webview2

That dialog is the signature of this failure. Never use that NuGet chain.

## Trap 2 — `./webview2-runtime` is rejected at runtime

Tauri sets `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` to `exe_dir.join(<path>)`.
With `path: "./webview2-runtime"` that yields `...\Recon\.\webview2-runtime`, and
the WebView2 loader refuses it — the app starts, creates no webview and shows the
error above. `path: "webview2-runtime"` (no `./`) works. Proven by A/B on the
same binary: only the config string changed.

There is **no fallback**: if the folder is missing or invalid, Tauri does not
fall back to the installed runtime. Both failure modes look identical to the user.

## How the installer gets the folder

`tauri-bundler` has no `FixedRuntime` arm for NSIS — it will not copy the folder
by itself. Ship it as a bundle resource:

```json
"bundle": {
  "resources": ["webview2-runtime/"],
  "windows": { "webviewInstallMode": { "type": "fixedRuntime", "path": "webview2-runtime" } }
}
```

The NSIS template does `SetOutPath $INSTDIR` then `File /oname=<relative path>`,
so files land at `$INSTDIR\webview2-runtime\...` — exactly where the runtime
looks. The portable zip is unaffected: `Recon\recon.exe` + `Recon\webview2-runtime\`.

## Verifying a build really uses it

The only acceptance test that matters: with Recon running, the WebView2 child
process must resolve **from the app's own folder**:

```
msedgewebview2.exe  parent = recon.exe
  C:\Users\<user>\AppData\Local\Recon\webview2-runtime\msedgewebview2.exe   <- ours
```

If it points at `C:\Program Files (x86)\Microsoft\EdgeWebView\...` the app is
still using the system runtime.

On Windows **10** unpackaged apps additionally need AppContainer read/execute
grants on the folder (`icacls ... /grant *S-1-15-2-2:(OI)(CI)(RX)` and
`*S-1-15-2-1`); Windows 11 does not. Tauri's installer does not apply them, so a
Windows 10 user would need a custom NSIS hook.
