# Updater signing key — runbook

The Tauri auto-updater only installs a release whose artifact is signed by the
private key matching the `pubkey` in `src-tauri/tauri.conf.json`. Lose the
private key and every future release is rejected by existing installs until
users install manually. That has happened twice.

Current key

| | |
|---|---|
| pubkey id | `77FD5160E2EB15E6` |
| created | 2026-11-08 |
| password | yes (random, stored with the key) |
| config | `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` |

## Where the key lives (three copies, keep all of them)

1. **Bitwarden** — item `Recon updater key (current, 77FD5160)`.
   The older `Recon updater key (OLD 6123DF …)` item is superseded; keep it for
   history, it cannot sign anything current.
2. **GitHub secrets** — `TAURI_SIGNING_PRIVATE_KEY` and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` on `youssefvdel/Outpeek`. This is what CI
   uses. Secrets are write-only: they cannot be read back.
3. **This server** — `~/backups/recon/updater-key/` (mode 700: `recon.key`,
   `recon.key.pub`, `key.pass`) plus a copy in
   `/mnt/data/backups/recon-updater-key/`.

## Verifying a release is signed by the current key

```bash
# pubkey as minisign expects it
python3 -c "import base64,json;d=json.load(open('src-tauri/tauri.conf.json'));open('/tmp/k.pub','wb').write(base64.b64decode(d['plugins']['updater']['pubkey']))"

gh release download vX.Y.Z --pattern '*.sig' --dir /tmp
base64 -d /tmp/Recon_X.Y.Z_x64-setup.exe.sig > /tmp/sig
minisign -Vm /tmp/Recon_X.Y.Z_x64-setup.exe -p /tmp/k.pub -x /tmp/sig
```

`Signature and comment signature verified` means the artifact matches the
configured key. A `key id` mismatch means the release was signed with a
different key than the build trusts.

## Rotating (only when the key is genuinely gone)

1. `bun x @tauri-apps/cli signer generate -w new.key -p "$(openssl rand -base64 24)"`
2. Put the base64 of `new.key.pub` into `plugins.updater.pubkey`.
3. `gh secret set TAURI_SIGNING_PRIVATE_KEY < new.key`
   `gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD < <(cat key.pass)`
4. Store key + password in Bitwarden (new item, name it with the new key id).
5. Copy to `~/backups/recon/updater-key/` and `/mnt/data/backups/`.
6. Cut a release. **Every existing install will refuse it** — that is the
   one-time manual install cost of rotating.

## Why twice already

- 2026-10-14: old key lost with a Windows reinstall → rotated.
- 2026-10-14, 10 minutes later: rotated again; the first rotation's key went to
  Bitwarden, the second only to GitHub secrets. The second was therefore
  unbackupable and is now replaced by the key this document describes.
