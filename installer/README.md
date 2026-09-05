# MD Previewer — Installer

Per-user Windows installer for MD Previewer, built with [Inno Setup 6](https://jrsoftware.org/isdl.php).

Installs to `%LOCALAPPDATA%\Programs\MdPreviewer\` (no admin / UAC required).
Optionally registers `.md` / `.markdown` association, folder right-click menu,
and `.md` file right-click menu — all under `HKCU`, all removed on uninstall.

## Prerequisites

- Rust toolchain (`cargo`)
- Python 3 + Pillow (only when regenerating the icon)
- Inno Setup 6 (`ISCC.exe`)
  - `winget install JRSoftware.InnoSetup` でインストール可
  - winget はユーザースコープに入れるので、`ISCC.exe` のパスは
    `%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe` になる（PATH に通っていない）
  - フルパスで叩くか、`$env:Path += ";$env:LOCALAPPDATA\Programs\Inno Setup 6"` で一時的に通す

## Build

```powershell
# 1. (one-time / when icon changes) regenerate assets/icon.ico
python tools\make-icon\make_icon.py

# 2. release build — build.rs embeds assets/icon.ico into the exe via app.rc
cargo build --release

# 3. compile the installer
# (PATH に通している場合)
iscc installer\md-previewer.iss
# (winget 既定パスから直接叩く場合)
& "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe" installer\md-previewer.iss
```

Output: `dist\MdPreviewer-Setup-<version>.exe`

## Samples

リポジトリ直下の `samples/` は `..\samples\*` 経由で `{app}\samples`
（= `%LOCALAPPDATA%\Programs\MdPreviewer\samples`）に展開され、スタートメニュー
の **"Sample Documents"** ショートカットからエクスプローラで開けます。
機能デモ用の `.md` ファイル一式で、アンインストール時に他のファイルと
一緒に削除されます。任意なので、ユーザーが削除しても本体動作には影響しません。

## Third-party licenses

`assets/THIRD_PARTY_LICENSES.txt` is included automatically through the
`..\assets\*` recurse in `[Files]`. The installer surfaces it in two ways:

- A Start-menu shortcut **"Third-party Licenses"** in the MD Previewer group
  that opens the file in the user's default text viewer.
- A **"サードパーティライセンスを表示 / View third-party licenses"** checkbox
  on the final wizard page (off by default).

Regenerate the file with `pwsh -File tools/collect-licenses.ps1` whenever
any bundled dependency changes — see the project root `README.md` for the
full procedure.

## TikZ component (downloaded, not bundled)

`@rod2ik/tikzjax` — the WASM TeX engine behind the ` ```tikz ` / ` ```tikzcd `
fenced blocks — is **deliberately excluded from the installer**
(`Excludes: "libs\tikzjax\*"` on the `..\assets\*` entry in `[Files]`).

**Why.** It is GPL-3.0-or-later and bundles LPPL-licensed TeX packages plus
compiled WASM binaries (`tex.wasm.gz`, `core.dump.gz`). Shipping a compiled GPL
binary obliges the distributor to also offer its Corresponding Source. Having
the user's own machine fetch it from the upstream npm registry means this
product never conveys those binaries, so that obligation never arises. It also
halves the setup: ~13 MB → ~7 MB.

**How.** The `tikz` wizard task (**on by default**) triggers a `[Code]`
`CurStepChanged(ssPostInstall)` handler that downloads
`https://registry.npmjs.org/@rod2ik/tikzjax/-/tikzjax-<ver>.tgz`, verifies its
SHA-256, and extracts it with Windows' bundled `tar.exe` into
`{app}\assets\libs\tikzjax\dist\`. The tarball's own `LICENSE` is extracted
alongside `dist\`. This mirrors the tikzjax block of `tools\fetch-libs.ps1`,
which does the same job for a dev checkout.

**Failure is always soft.** No internet, a blocking proxy, a hash mismatch or a
missing `tar.exe` all leave a fully working previewer — only `tikz` / `tikzcd`
blocks are affected, and they render an actionable message instead of a
diagram (the Rust host probes for the engine and exposes
`window.__tikzAvailable` to `assets\index.html`). Re-running the installer
retries. Look for `tikz:` lines in the install log (`/LOG=`) to diagnose.

**Upgrades never re-download.** The handler skips when
`assets\libs\tikzjax\dist\tikzjax.js` already exists, and the `Excludes` above
means `[Files]` never touches an existing copy. Bumping `#define
TikzjaxVersion` therefore does *not* upgrade an existing install's engine;
delete the folder first if you need that.

### Mirroring it internally

For machines that cannot reach the npm registry, point the installer elsewhere.
Highest priority first:

1. `MdPreviewer-Setup-x.y.z.exe /TIKZSRC="\SERVER\share\rod2ik-tikzjax-1.5.0.tgz"`
   (optionally `/TIKZSHA256=<digest>`; an `http(s)` URL works too)
2. `{app}\assets\tikz-source.ini` — the same `assets\*` overlay mechanism
   used for `update.json`. See
   `assets/tikz-source.example.ini`. INI rather than JSON because Inno Setup
   has `GetIniString` built in and Unicode-safe, and no JSON parser at all;
   `update.json` stays JSON because *its* consumer is Rust/serde.
3. the compiled-in upstream URL.

> **⚠ Licensing.** Putting the `.tgz` on a mirror makes *you* the distributor.
> Handing it to your own organisation's employees for internal use is not
> "conveying" under GPLv3 and needs nothing further. If the mirror is reachable
> from outside the organisation, you must also accompany it with the
> Corresponding Source (including the sources `tex.wasm` / `core.dump` were
> built from) or a written offer for it. Do not put it on a public share.

### Bumping the pinned version

`#define TikzjaxVersion` in `installer/md-previewer.iss` and `$TikzjaxVersion`
in `tools/fetch-libs.ps1` are **two separate pins that must be kept in sync**
(the `.iss` cannot read the PowerShell script). After changing the version:

```powershell
curl -sL https://registry.npmjs.org/@rod2ik/tikzjax/-/tikzjax-<ver>.tgz | sha256sum
```

and paste the digest into `#define TikzjaxSha256`.

## Post-install options

The final wizard page offers three optional checkboxes (all `skipifsilent`):

| Checkbox | Default | Action |
| --- | --- | --- |
| Launch MD Previewer | on | runs `md-previewer.exe` |
| インストール先フォルダを開く / Open install folder | off | opens `{app}` in Explorer |
| サードパーティライセンスを表示 / View third-party licenses | off | opens `THIRD_PARTY_LICENSES.txt` |

## Versioning

Update both:
- `Cargo.toml` `version =`
- `installer/md-previewer.iss` `#define AppVersion`

Keep the `AppId` GUID stable so subsequent installers upgrade existing
installs in-place (and produce a single entry in "Apps & features").

## Uninstall

Settings → Apps → installed apps → "MD Previewer" → Uninstall.
Removes the program folder, the Start menu group, every `HKCU` key written
by the installer, and the Uninstall registration.

Files in `%LOCALAPPDATA%\md-previewer\` written by the running app
(e.g. `md-previewer.log`) are **not** removed by uninstall — delete by hand
if desired.
