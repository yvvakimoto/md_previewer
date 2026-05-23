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
