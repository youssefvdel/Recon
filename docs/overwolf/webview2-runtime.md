# WebView2 fixed-version runtime — official source, version to pin, and why NuGet failed

2026-11-08. Evidence gathered live: page fetch, Edge release API, and a full download +
listing of Microsoft's x64 fixed-version `.cab` (310,801,569 B) compared against the NuGet
package we used. No PC access.

## TL;DR

The official fixed-version runtime is a **`.cab` linked from Microsoft's WebView2 download
page**. There is **no documented JSON API**, but the page is server-rendered Nuxt and the cab
URLs are present in the returned HTML inside `__NUXT_DATA__` (as `\u002F`-escaped strings), so
it is resolvable programmatically by one fetch + regex. Pin **157.0.4341.42 x64**. The NuGet
package `WebView2.Runtime.X64` is a **third-party repack (author ProKn1fe)** that ships
`msedge.dll.sig` but **not `msedge.dll`** — which is exactly why Tauri `fixedRuntime` gave
zero windows.

## 1. Canonical download (official, complete)

Page: `https://developer.microsoft.com/microsoft-edge/webview2/#download-the-webview2-runtime`
(also reachable as `https://www.microsoft.com/en-us/microsoft-edge/webview2/`).

The page lists the **latest two fixed versions** (currently 156 and 157) for x86 / x64 /
arm64. Resolve without clicking:

```bash
curl -sSL 'https://developer.microsoft.com/microsoft-edge/webview2/' \
 | sed 's/\\u002F/\//g' \
 | grep -oE 'https://[^"\\ ]*Microsoft\.WebView2\.FixedVersionRuntime\.[0-9.]+\.(x64|x86|arm64)\.cab' \
 | sort -u
```

Measured 2026-11-08: 15 cab URLs (versions 153.0.4234.48, 154.0.4258.62, 155.0.4283.62,
156.0.4314.58, 157.0.4341.42, each x86/x64/arm64). Excerpt:

```
https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/b7b22a57-b321-483e-9855-d260b076f1a7/Microsoft.WebView2.FixedVersionRuntime.157.0.4341.42.x64.cab
```

**Version to pin (x64): `157.0.4341.42`**
- URL: the one above; `Content-Length: 310801569`; `Last-Modified: Thu, 05 Nov 2026 21:01:30 GMT`
- SHA256 of the cab: `cedaf8f3d12202c8803bdbae727b01c1be34540b78e8f0a10c6b401c2a8be97d`
- Extracts to a single folder: `Microsoft.WebView2.FixedVersionRuntime.157.0.4341.42.x64/`
- Uncompressed: **257 files, 678 MiB**; the folder also has `EBWebView/`, `WidevineCdm/`,
  `Installer/`, `Locales/` (168 `.pak`).

`https://edgeupdates.microsoft.com/api/products?view=enterprise` works and returns JSON, but
it has **no WebView2 product** — only `Dev`, `Beta`, `Stable`, `EdgeUpdate`, `Policy` (Edge
browser MSI/CAB artifacts). It is useful only as a version cross-check: its current Stable
Edge is `157.0.4341.42`, the same build as the newest fixed runtime. It cannot supply the
runtime URL.

## 2. Required-file checklist (assert before packaging)

A valid runtime folder must contain at least these; sizes are from the real 157 cab:

| File | Size (bytes) |
| --- | --- |
| `msedge.dll` | 357,748,040 |
| `msedge.dll.sig` | 1,389 |
| `msedgewebview2.exe` | 4,532,552 |
| `msedgewebview2.exe.sig` | 1,389 |
| `msedge_elf.dll` | 4,068,168 |
| `resources.pak` | 34,062,108 |
| `icudtl.dat` | 12,409,424 |
| `v8_context_snapshot.bin` | 770,184 |
| `msedge_100_percent.pak` / `msedge_200_percent.pak` | 1,175,016 / 1,865,133 |
| `157.0.4341.42.manifest` | 226 |
| `Locales/en-US.pak` (+ 167 more locales) | ~1 MB each |
| `ffmpeg.dll`, `msvcp140.dll`, `concrt140.dll`, `d3dcompiler_47.dll`, `dxcompiler.dll`, `notification_helper.exe` | — |

Build-time assertion (PowerShell) — cheap and catches the exact regression we hit:

```powershell
$p = "path\to\Microsoft.WebView2.FixedVersionRuntime.157.0.4341.42.x64"
foreach ($f in 'msedge.dll','msedge_elf.dll','msedgewebview2.exe',
               'resources.pak','icudtl.dat','v8_context_snapshot.bin') {
  if (-not (Test-Path (Join-Path $p $f))) { throw "WebView2 fixed runtime missing $f" }
}
if ((Get-Item (Join-Path $p 'msedge.dll')).Length -lt 300MB) { throw "msedge.dll is a stub" }
if (-not (Test-Path (Join-Path $p 'Locales\en-US.pak'))) { throw "Locales missing" }
```

A `.sig` file is **not** a substitute for its binary. `msedge.dll.sig` exists specifically so
Windows can validate `msedge.dll`; a folder with the `.sig` and no DLL starts no browser
process at all (observed: zero windows, no `msedgewebview2.exe` child).

## 3. Why the NuGet package failed

`webview2.runtime.x64` is **not Microsoft's package**. Its nuspec says:

```
<id>WebView2.Runtime.X64</id> <version>157.0.4341.42</version>
<authors>ProKn1fe</authors>
<projectUrl>https://github.com/ProKn1fe/WebView2.Runtime</projectUrl>
<dependencies><dependency id="WebView2.Runtime.X64.Core" version="157.0.4341.42" /></dependencies>
```

Measured: the package is 100,691,588 B and carries **56 runtime files vs the cab's 257**.
It includes `msedge.dll.sig`, `msedgewebview2.exe`, `msedge_elf.dll`, `resources.pak`,
`icudtl.dat`, `v8_context_snapshot.bin` — but **`msedge.dll` (341 MiB) is absent**, along
with 202 other files (167 locales, `dxcompiler.dll`, `d3dcompiler_47.dll`, Copilot assets…).
The wrapper delegates the heavy binaries to its `.Core` dependency (159,493,139 B), which is
still not the full 341 MiB browser binary. Conclusion: **do not use this NuGet chain for
fixed-version distribution.** Use the official cab.

## 4. Redistribution — allowed

Microsoft's own docs state: *"The WebView2 Runtime is a** redistributable runtime** and
serves as the underlying (or backing) web platform for WebView2 apps"*
([Evergreen vs. fixed version](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version)),
and the distribution guide instructs: *"Download the Fixed Version of the WebView2 Runtime …
as a package … Include all of the decompressed Fixed Version binaries in your app package, to
be deployed on the target machine during your app's installation"*
([Distribute your app](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)).
So shipping the unmodified folder inside our installer is the intended use. Constraints:
ship it unmodified, keep Microsoft's notices intact, and note the size cost — the docs say
fixed-version binaries are **over 250 MB** (measured 678 MiB unpacked).

## 5. Gotchas we must handle

- **Win10 + unpackaged app + fixed version ≥ 120**: the renderer runs in an AppContainer, so
  the install folder needs `icacls <folder> /grant *S-1-15-2-2:(OI)(CI)(RX)` and
  `icacls <folder> /grant *S-1-15-2-1:(OI)(CI)(RX)` (ALL APPLICATION PACKAGES / ALL RESTRICTED
  APPLICATION PACKAGES). Without it, WebView2 fails with access-denied. Windows 11 and packaged
  apps are unaffected.
- **No UNC / network path**: "Fixed Version cannot be run from a network location or UNC path."
- **Extraction tool**: Microsoft warns that extracting with File Explorer "might not generate
  the correct folder structure" — use a real archiver that preserves the folder tree.
- **Tauri config** (`tauri-utils 2.9.3` schema): `WindowsConfig.webviewInstallMode` is an enum
  with `FixedRuntime { path: PathBuf }`; the doc comment says *"The `.cab` file must be
  extracted to a folder and this folder path must be defined on this field."* So:

```json
"bundle": { "windows": { "webviewInstallMode": {
  "type": "fixedRuntime",
  "path": "./Microsoft.WebView2.FixedVersionRuntime.157.0.4341.42.x64/"
} } }
```

- Current repo config is `{"type":"downloadBootstrapper","silent":true}` — the evergreen path,
  which never needed any of this. Fixed runtime is only worth it if pinning the browser
  version is a hard product requirement.

## 6. Not verified

- That the official cab, extracted correctly and configured in `tauri.conf.json`, boots the
  app on Windows 10/11 (that requires a Windows build; we validated the payload, not a bundle).
- Whether Tauri's NSIS bundler preserves the folder layout and applies the AppContainer ACLs.
- The exact reason ProKn1fe's wrapper omits `msedge.dll` (size limits or Core-package
  refactor); irrelevant once we use the official cab.

## Sources

- Fixed-version download page: https://developer.microsoft.com/microsoft-edge/webview2/
- Distribution guide: https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution
- Evergreen vs fixed (redistributable quote): https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version
- Edge release API: https://edgeupdates.microsoft.com/api/products?view=enterprise
- Third-party NuGet repack (do not use): https://github.com/ProKn1fe/WebView2.Runtime
