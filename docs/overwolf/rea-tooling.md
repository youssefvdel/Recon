# REA (`morluto/rea`) — evaluated for the Tracker Network Overwolf app

Verdict up front: **usable on this Linux box for the static half of the job;
not a shortcut for the runtime half.** It does not know what Overwolf is, and it
will not decompile a native DLL without an analysis engine installed. What it
does well — static JS/Electron reconstruction with an Evidence bundle — is real
and verified working here.

Evaluated on: `youssef-server`, 2026-11-08, `rea-agents@6.8.0` (MIT).

## What it actually is

An MCP server plus a CLI ("Reverse Engineer Anything"). TypeScript, 43 runtime
deps, `bin: rea`. It is a *tool surface for an agent* — this session's model is
the brain; REA ships no LLM and needs no provider key. It shells out to
optional external engines (Hopper/IDA/Ghidra/JEB/JADX/Frida/GDB/Rizin) when a
capability needs one, and falls back to built-in static parsers when it does
not.

## Capability check against our target

Target shape: an Overwolf `.opk` — a ZIP with `manifest.json`, an HTML/JS/CSS
app bundle, and optionally a native plugin DLL (C++ or C#).

| Capability | Works here? | Notes |
| --- | --- | --- |
| Extract/inspect a package, file inventory, digests | **Yes** | Point it at the unzipped directory. `.opk` is just ZIP — unzip it first. |
| Static JS/Electron app reconstruction (modules, imports, routes, IPC, source maps, native add-on links) | **Yes, verified** | `analyze-javascript-application`. This is the main prize. |
| Web bundle capture + page structure | **Yes** | Needs a Chrome-family browser (Brave is installed). |
| Saved network captures (HAR / Fiddler SAZ) | **Yes** | Static parse of a capture we produce. |
| .NET / C# assembly metadata + CIL | **Yes** | "None (static only)" per its own docs — no ilspycmd needed. Useful if the plugin is C#. |
| PE imports, Authenticode certificates, hardening flags | **Yes** | Built-in static PE inspection; good first triage on any DLL. |
| Native x64 pseudocode/assembly of the DLL | **Needs an engine** | Ghidra (Linux-native, Java) or IDA/Hopper. `doctor` reports all four missing. Not Windows-gated, but a multi-GB install. |
| Live Overwolf/Electron runtime capture (Frida, process capture, memory) | **Needs Windows** | Frida attaches to a running process; the Overwolf Electron host only exists on the user's PC. Do not run this here. |
| Memory inspection / injection | Not offered | No memory-read tooling in the catalog. Good — matches Recon's own read-only rule. |

## Measured on this box (not estimates)

- `npx rea-agents@6.8.0 --version` → `6.8.0`. Node 26.13.0 satisfies
  `^22.23.4 || ^24.22.1 || >=26.12.1`. **Runs.**
- `doctor` → `node: healthy (26.13.0)`, `host: healthy (ubuntu 26.04)`,
  `hopper/ghidra/ida/jadx: missing_analysis_engine`. Everything else green.
- Single-file run on a real 40 kB bundle
  (`analyze-javascript-application <dir> --artifact-format directory --source-path assets/AccountsView-CI89yArL.js --detail summary --evidence_output out.json`):
  **5.5 s wall, 4.1 MB Evidence JSON**, exit 0.
- Same command over the whole 31-file / ~1.4 MB Vite bundle: **did not finish in
  180 s**, stalled while semantically analyzing the 1 MB minified `index-*.js`.
  A minified production bundle is the worst case for an AST-heavy analyzer, and
  an Overwolf app bundle is likely the same shape. Plan on `--source-path` /
  `--analysis-timeout-ms` / `--max-semantic-nodes` per interesting file, not one
  sweep of everything.

## Install cost

- Published package: **49.25 MB unpacked** (`npm view rea-agents dist.unpackedSize`).
  `npx rea-agents` caches it under `~/.npm` — no system-wide install, nothing in
  `node_modules` of any repo.
- Source clone: 105 MB working tree + 25 MB `.git`; a clone **cannot** be run
  directly (ships TS source) — it needs `npm ci && npm run build:cached`.
  Use `npx` instead; the clone is only useful for reading docs, which is what I
  did (`/tmp/rea`, disposable).

## Which route for us

1. Copy the `.opk` off the PC, `unzip` it to `~/Lab/overwolf/<app>/`.
2. `npx rea-agents@6.8.0 analyze-javascript-application <dir> --artifact-format directory --detail summary --evidence_output /tmp/ow.json`
   — expect it to crawl on the big minified file; select files with
   `--source-path` if it stalls.
3. `npx rea-agents@6.8.0 doctor` before trusting any result; it names exactly
   which engine is missing for the capability you asked for.
4. For the DLL: `file`, `objdump -p` (imports) and REA's built-in PE tools first;
   install Ghidra only if the strings/import triage says the logic lives there.

## Fallback toolkit (what I would reach for first, honestly)

REA's win over this list is the *integration into the agent*, not raw power.

- **Unpack:** `unzip app.opk -d app/` — `.opk` is a plain ZIP.
- **Read the JS:** `npx prettier --write app/js/*.js` (or `bunx js-beautify`),
  then `grep -n` for `fetch(`, `XMLHttpRequest`, `ws://`, `wss://`,
  `overwolf.`, `tracker.gg`, `api.`.
  Recon already has this instinct: `scripts/probe-trn-warden.ts` is the same
  move pointed at an HTTP endpoint.
- **Native DLL triage:** `file`, `objdump -p` (import table), `strings -n 8`,
  `nm -D` if unstripped. That answers "is the logic here or in the JS?" 90% of
  the time.
- **.NET DLL:** `ilspycmd -p -o out/ plugin.dll` — **runs on Linux**, or REA's
  built-in managed inspection if we want it inside the agent.
- **Deep native:** Ghidra headless (`analyzeHeadless`) on Linux; IDA/Hopper are
  Windows/macOS-licensed and not present here.
- **Runtime (the only truly Windows part):** run the Overwolf app on the PC and
  capture with Fiddler/Charles as a SAZ/HAR, then hand the capture to REA here.
  That keeps everything interactive on Linux.

## Bottom line

- **Usable here:** package/JS/Electron/.NET/PE static analysis, network-capture
  analysis, web bundle capture. Verified with a real bundle.
- **Needs Windows:** live Overwolf process/Electron runtime tracing.
- **Needs a separate engine (not Windows):** native x64 decompilation.
- **Not worth it** as a way to "just open the app": the 49 MB MCP server earns
  its keep when the agent drives many analysis steps. For a one-off look, unzip +
  prettier + strings is faster than wiring REA into the session.
