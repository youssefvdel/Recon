# Code signing — Windows builds

Recon's Windows binary is Authenticode-signed in CI with a **self-signed**
certificate. It removes the "Unknown publisher" line from Windows' warnings on
machines where the certificate is installed. It does **not** buy SmartScreen
reputation on a stranger's machine. That is a purchase, not a build step; see
[What self-signing does not solve](#what-self-signing-does-not-solve).

## Why Windows complained

`recon.exe` was shipped unsigned. Browsers and other internet downloads also tag
the file with **Mark-of-the-Web** (a `Zone.Identifier` alternate data stream), so
Windows runs SmartScreen on launch. An unsigned, untrusted download has no
publisher and no reputation, and SmartScreen says so:

- "Windows protected your PC"
- "Microsoft Defender SmartScreen prevented an unrecognized app from starting"
- Publisher: **Unknown publisher**

"More info → Run anyway" worked, but every user saw a warning that reads like a
virus alert. Signing fixes the publisher identity; the timestamp proves the file
was signed while the certificate was valid.

## What we sign with

| Property | Value |
| --- | --- |
| Type | Self-signed Authenticode certificate (no CA chain) |
| Subject | `CN=Youssef Adel, O=Recon, C=EG` |
| Key | RSA 4096 |
| Digest | SHA-256 |
| Validity | 2026-11-07 → 2031-11-07 (5 years) |
| Timestamp | DigiCert RFC 3161, `http://timestamp.digicert.com` |

The CI step **"Sign recon.exe"** in `.github/workflows/build-windows.yml` runs
after the build and before the artifact upload:

1. If `WINDOWS_SIGN_PFX_B64` is empty, it logs that signing is skipped and exits
   `0` — forks and runs without secrets still get a build.
2. Decodes the PFX to a temporary file under `$RUNNER_TEMP`.
3. Finds `signtool.exe` under `%ProgramFiles(x86)%\Windows Kits\10\bin\*\x64\`.
4. Signs with `/fd SHA256 /tr http://timestamp.digicert.com /td SHA256`.
5. Asserts `Get-AuthenticodeSignature` returns a signer certificate.

That last assertion is deliberately **not** `signtool verify /pa`. `/pa` fails
for a self-signed root that the runner does not trust, which says nothing about
the signature. It failed once for exactly that reason. On a machine where the
certificate is installed, the same file verifies cleanly; on the runner it only
needs to prove a signature was written. In this repo, signing failure throws, so
the job stops before upload — a broken signature cannot reach the artifact. The
only unsigned path is the secret-less skip above, which is for forks, not releases.

Secrets used (names only, values never in the repo):

| Secret | Holds |
| --- | --- |
| `WINDOWS_SIGN_PFX_B64` | the PFX file, base64-encoded |
| `WINDOWS_SIGN_PFX_PASSWORD` | the PFX password |

## Creating or rotating the identity

All commands run on a trusted machine, with a placeholder directory. Keep the
private key and PFX offline; nothing here is committed.

```bash
mkdir -p ~/recon-signing && cd ~/recon-signing

# 1. RSA-4096 key + self-signed code-signing certificate (~5 years).
#    CA:TRUE + keyCertSign make it a valid root of its own chain.
openssl req -x509 -newkey rsa:4096 -sha256 -days 1826 -nodes \
  -keyout recon-signing.key -out recon-signing.crt \
  -subj "/CN=Youssef Adel/O=Recon/C=EG" \
  -addext "keyUsage=critical,digitalSignature,keyCertSign" \
  -addext "extendedKeyUsage=critical,codeSigning" \
  -addext "basicConstraints=critical,CA:TRUE"

# 2. Bundle cert + key into a PKCS#12. Choose a strong password.
openssl pkcs12 -export -inkey recon-signing.key -in recon-signing.crt \
  -name "Recon code signing" -out recon-signing.pfx

# 3. Base64 the PFX and push it as a secret from the repo root.
openssl base64 -A -in recon-signing.pfx -out recon-signing.pfx.b64
gh secret set WINDOWS_SIGN_PFX_B64 < recon-signing.pfx.b64
gh secret set WINDOWS_SIGN_PFX_PASSWORD   # paste at the prompt, do not type on the command line
```

`recon-signing.crt` is public and can be attached to a release or shipped with
the app. `recon-signing.key` and `recon-signing.pfx` are not.

If Windows refuses the PFX ("password incorrect" on an older `signtool`), re-export
with `openssl pkcs12 -export -legacy ...`. Legacy uses weaker (RC2) encryption —
only use it when the modern PFX cannot be imported.

To rotate: generate a new key/cert pair, export a new PFX, update **both** secrets
in the same sitting, then cut a fresh build. Users who installed the old
certificate must install the new one, so publish `recon-signing.crt` with each
release. Never update one secret without the other — signing fails, and that is
the desired loud failure.

## Installing the certificate on a user's machine

The certificate is public. A user who wants to stop seeing the warning installs
it once, from an **administrator** PowerShell:

```powershell
certutil -addstore -f Root recon-signing.crt
certutil -addstore -f TrustedPublisher recon-signing.crt
```

- `Root` closes the chain (the cert is its own root).
- `TrustedPublisher` is what replaces "Unknown publisher" with the subject name.

The same thing through the GUI: double-click `recon-signing.crt` → Install
Certificate → Local Machine → "Place all certificates in the following store" →
Trusted Root Certification Authorities, then repeat for Trusted Publishers.

One download detail: a browser download sets Mark-of-the-Web, so the first launch
still goes through SmartScreen. Fetching with PowerShell does not:

```powershell
Invoke-WebRequest -Uri <download-url> -OutFile recon.exe
```

MOTW alone is not the warning's cause — an untrusted signature is — but it is why
a freshly downloaded file is checked even when it was never run before.

## What self-signing does not solve

Self-signing changes nothing for people who have not installed the certificate:
their machine still reports an unknown publisher, because Windows has no reason
to trust a root it has never seen. It is right for a project shipping to its own
testers and for local builds; it is not a substitute for a publicly trusted
certificate.

**Free programs are not available here.** SignPath Foundation and Certum's
open-source signing are for OSI-licensed open-source projects. Recon's `LICENSE`
is proprietary, so neither applies.

Options that do work:

| Path | What it gets you | Rough cost |
| --- | --- | --- |
| OV code signing certificate | Publisher name in the dialog; SmartScreen reputation still accumulates over time | ~$200–450/year, identity-verified, key on a hardware token or HSM |
| EV code signing certificate | Instant SmartScreen trust — no warning on first run | ~$400–800/year, stricter identity checks, token/HSM required |
| Azure Trusted Signing | Microsoft-hosted signing; cheaper than a classic cert | ~$10/month, but the account needs a verified organization with a track record |
| Microsoft Store | Microsoft signs the package; installs come from the Store, no SmartScreen prompt | $19 one-time (individual) / $99 (company), MSIX packaging required |

Prices move; check the CA before budgeting. EV is the only one that behaves like
"no warning, ever, on any machine" from the first download.

## Signing locally (non-CI fallback)

CI is the normal path. If the workflow is unavailable, the same PFX signs on
Linux with `osslsigncode` (`apt install osslsigncode` on Debian/Ubuntu):

```bash
osslsigncode sign \
  -certs recon-signing.crt \
  -key recon-signing.key \
  -n "Recon" \
  -i "https://reconlab.app" \
  -h sha256 \
  -ts http://timestamp.digicert.com \
  -in recon-unsigned.exe \
  -out recon.exe
```

Verify the result. `-CAfile` tells `osslsigncode` that this self-signed root is
the expected one; without it the chain is reported as untrusted, which is normal
on Linux:

```bash
osslsigncode verify -CAfile recon-signing.crt -in recon.exe
```

Expect `Signature verification: ok` plus the signer subject. On Windows, the
equivalent is `signtool sign /fd SHA256 /f recon-signing.pfx /p "<password>" /tr
http://timestamp.digicert.com /td SHA256 recon.exe`, and verification only
succeeds on a machine that has installed the certificate — the runner lesson
above applies to any untrusted machine.

## Rollback

The signing step signs the freshly built binary in place; it does not keep a
copy. The rollback is the copy you make before replacing the file users run.

```powershell
# Before replacing the live binary (close Recon first — Windows locks the file):
Copy-Item recon.exe recon.exe.prev -Force

# If the new build misbehaves:
Copy-Item recon.exe.prev recon.exe -Force
```

The restored file is byte-identical, signature included. If the binary came from
CI, GitHub keeps the artifact for **7 days** (see `retention-days` in the
workflow) — download the build you may need to return to before publishing a new
one. Rerunning the workflow on the same commit rebuilds an equivalently signed
exe, but a published release is immutable; prefer a new version over mutating an
old tag.

If the signing step itself fails, the job fails before the upload. That is the
rollback-safe failure mode: there is no artifact to download, so nobody is
tempted to publish an unsigned build.
