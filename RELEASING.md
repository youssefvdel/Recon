# Releasing Recon

The in-app updater is **not** a GitHub download link. It uses Tauri's signed
updater: the app fetches `latest.json` from the newest GitHub release, downloads
the payload, verifies it against the **minisign public key** in
`src-tauri/tauri.conf.json`, installs quietly in place, and relaunches itself.

**If the signature does not verify, the update is refused.** That is the point.

---

## One-time setup (already done on this machine)

A signing keypair was generated with `tauri signer generate`:

| File | Where | Secret? |
| --- | --- | --- |
| `recon.key` — private, signs every release | `%LOCALAPPDATA%\Recon\signing\recon.key` | **YES — never commit, never share, never lose** |
| `recon.key.pub` — public, ships in the app | copy is inlined in `tauri.conf.json` → `plugins.updater.pubkey` | safe to publish |

> ⚠️ **Back the private key up somewhere safe.** If it is lost, no future release
> can be signed and every installed app will refuse updates — the fix would be a
> manual reinstall for every user.

---

## Cutting a release

### 1. Bump the version

```bash
bun run bump -- 0.4.0
```

The bump script writes **both** `package.json` and `src-tauri/Cargo.toml`. They must
match:

- `Cargo.toml` → `env!("CARGO_PKG_VERSION")` is what the app reports as *current*.
- `package.json` → the bundled app version (`tauri.conf.json` sets `"version": "../package.json"`).

If they drift, the updater compares against the wrong "current" version and either
never offers an update or offers one forever.

### 2. Build, signed

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$LOCALAPPDATA/Recon/signing/recon.key")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""   # key was generated without one
bun run tauri build
```

> Windows gotcha (hit 2026-09-15): the key is encrypted with an EMPTY password,
> and empty env vars cannot survive PowerShell/.NET (`$env:X = ''` deletes the
> var), so the build stalls at "Decrypting updater signing key, expect a prompt
> for password". Run the build from MSYS bash (e.g. Hermes-bundled Git), where
> `export ...=""` produces a real empty value that reaches Tauri. `python` is
> not installed on this box, so `make-latest-json.sh` fails — use the Node
> equivalent (same manifest shape) instead.

> Pass the key **contents**. `TAURI_SIGNING_PRIVATE_KEY_PATH` was tried first and did
> not take effect — the build proceeded unsigned and only warned at the very end.

Outputs under `src-tauri/target/release/bundle/`:

| Artifact | Purpose |
| --- | --- |
| `nsis/Recon_<v>_x64-setup.exe` | manual installer **and the updater payload** |
| `nsis/Recon_<v>_x64-setup.exe.sig` | **its signature — without this, updates are refused** |
| `msi/Recon_<v>_x64_en-US.msi` | enterprise install |
| `msi/Recon_<v>_x64_en-US.msi.sig` | its signature |

> Tauri v2 signs the NSIS `-setup.exe` directly. There is no `.nsis.zip` wrapper —
> don't go looking for one.

**Missing `.sig` files mean the build was not signed. Do not publish it.** The build
still "succeeds" and produces installers; signing failure shows up only as:

```
A public key has been found, but no private key.
Make sure to set `TAURI_SIGNING_PRIVATE_KEY` environment variable.
```

Use `TAURI_SIGNING_PRIVATE_KEY` (the key **contents**). The `..._PATH` variant did not
take effect on this setup. Confirm the `.sig` files exist before going further.

### 3. Generate `latest.json`

The updater endpoint is
`https://github.com/youssefvdel/Recon/releases/latest/download/latest.json`, so this
file must be attached to the release. Tauri does not create it outside CI, so there is
a script:

```bash
bash scripts/make-latest-json.sh 0.4.0 /tmp/recon_release_notes.md
```

It reads the `.sig` next to the setup exe and writes the manifest
(`version`, `notes`, `pub_date`, and `platforms["windows-x86_64"]{signature,url}`)
to `$TMPDIR/latest.json`. The signature must be the file **contents**, never a path.

### 4. Publish the release

```bash
V=0.4.0
B=src-tauri/target/release/bundle
gh release create "v${V}" \
  "$B/nsis/Recon_${V}_x64-setup.exe" \
  "$B/nsis/Recon_${V}_x64-setup.exe.sig" \
  "$B/msi/Recon_${V}_x64_en-US.msi" \
  "$B/msi/Recon_${V}_x64_en-US.msi.sig" \
  "$TMPDIR/latest.json" \
  --title "Recon v${V}" --notes-file notes.md --latest
```

Three assets go up: the setup exe, its `.sig`, and `latest.json` (bundle targets
are nsis-only, so there is no MSI).

Two rules:

- **Do not mark it a prerelease or draft.** `/releases/latest` skips both, so the
  updater would never see it.
- The tag must be higher than the running build (`v0.4.0` > `0.3.0`).

### 5. Verify before telling anyone

```bash
# 1. the release is the newest and not excluded
gh release view "v0.4.0" --json tagName,isDraft,isPrerelease,assets \
  --jq '{tag:.tagName, draft:.isDraft, pre:.isPrerelease, assets:[.assets[].name]}'

# 2. the exact endpoint the app polls resolves
curl -sL -o /tmp/v.json -w "%{http_code}\n" \
  https://github.com/youssefvdel/Recon/releases/latest/download/latest.json

# 3. the manifest points at a real download
python -c "import json;m=json.load(open('/tmp/v.json'));print(m['version']);print(m['platforms']['windows-x86_64']['url'])"
```

Then install an **older** build and use **Settings → Check for updates**: it should
offer the new version, download with a progress bar, and restart itself. A build can
only update itself if it already contains the plugin — 0.3.0 was the first.

---

## Why the app can't just replace its own .exe

Windows will not let a running process overwrite its own executable, and Recon
keeps a WebView2 runtime and an overlay window alive. Every serious Windows app
therefore hands off to a signed installer or an updater helper; the "silent
in-place" experience is the installer running with `/S` and no UI while the app
exits and relaunches. That is what the plugin does here — the difference from the
old flow is verification, a real manifest, progress and an automatic restart.

## Legacy

`src-tauri/src/updater.rs` (`check_app_updates` / `install_app_update`) is the old
GitHub-API flow: it guessed an asset by file extension, downloaded it to `%TEMP%`
and shell-executed it, with no signature check. It is no longer wired into the UI
and should be deleted once no build still calls it.
