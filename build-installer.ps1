param(
    [switch]$SkipBuild,
    [switch]$SkipLicenses,
    [string]$Iscc
)

$ErrorActionPreference = 'Stop'

$RepoRoot = $PSScriptRoot
$BuildScript = Join-Path $RepoRoot 'build.ps1'
$CollectLicenses = Join-Path $RepoRoot 'tools\collect-licenses.ps1'
$IssScript = Join-Path $RepoRoot 'installer\md-previewer.iss'
$DistDir = Join-Path $RepoRoot 'dist'

# Hash HISTORY.md's CONTENT, not its bytes.
#
# This clone has core.autocrlf=true, so git rewrites HISTORY.md with CRLF on
# checkout while release-on-main.ps1 writes it with LF. A raw-byte hash then
# differs for a file whose content never changed, and `-Verify` reports the
# bundled notes as stale on a perfectly good release (measured on v0.30.0:
# stamp 2DDC..., working tree ED14...). Normalizing to LF first is the same
# rule tools/preview-harness/tablecheck.py already applies to its payloads.
#
# MIRROR: release-on-main.ps1 has the same function -- keep in sync.
function Get-NotesHash($path) {
    $text  = [System.IO.File]::ReadAllText($path) -replace "`r`n", "`n"
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    $ms    = [System.IO.MemoryStream]::new($bytes)
    try { (Get-FileHash -InputStream $ms -Algorithm SHA256).Hash }
    finally { $ms.Dispose() }
}

function Invoke-External {
    param(
        [Parameter(Mandatory)][string]$File,
        [string[]]$Arguments = @(),
        [string]$Description
    )
    Write-Host "==> $Description" -ForegroundColor Cyan
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed (exit code $LASTEXITCODE): $File $($Arguments -join ' ')"
    }
}

function Resolve-Iscc {
    param([string]$Explicit)

    if ($Explicit) {
        if (-not (Test-Path -LiteralPath $Explicit)) {
            throw "ISCC not found at the provided path: $Explicit"
        }
        return (Resolve-Path -LiteralPath $Explicit).Path
    }

    $cmd = Get-Command iscc -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $candidates = @(
        "${env:LOCALAPPDATA}\Programs\Inno Setup 6\ISCC.exe",
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "${env:ProgramFiles}\Inno Setup 6\ISCC.exe",
        "${env:LOCALAPPDATA}\Programs\Inno Setup 5\ISCC.exe",
        "${env:ProgramFiles(x86)}\Inno Setup 5\ISCC.exe",
        "${env:ProgramFiles}\Inno Setup 5\ISCC.exe"
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    }

    throw "ISCC.exe not found. Install Inno Setup 6 (https://jrsoftware.org/isdl.php) or pass -Iscc <path>."
}

function Get-IssVersion {
    $line = Select-String -LiteralPath $IssScript -Pattern '^\s*#define\s+AppVersion\s+"([^"]+)"' | Select-Object -First 1
    if (-not $line) { throw "Could not read AppVersion from $IssScript" }
    return $line.Matches[0].Groups[1].Value
}

# 1. Build the exe + sync assets
if (-not $SkipBuild) {
    Invoke-External -File 'pwsh' -Arguments @('-NoProfile', '-File', $BuildScript) -Description 'build.ps1 (release)'
} else {
    Write-Host '==> -SkipBuild specified, assuming target\release\md-previewer.exe is up to date' -ForegroundColor DarkGray
}

# 2. Regenerate THIRD_PARTY_LICENSES.txt
if (-not $SkipLicenses) {
    Invoke-External -File 'pwsh' -Arguments @('-NoProfile', '-File', $CollectLicenses) -Description 'collect-licenses.ps1'
} else {
    Write-Host '==> -SkipLicenses specified, leaving assets\THIRD_PARTY_LICENSES.txt as-is' -ForegroundColor DarkGray
}

# 3. Locate ISCC and compile the installer
$IsccPath = Resolve-Iscc -Explicit $Iscc
Write-Host "==> Using ISCC: $IsccPath" -ForegroundColor DarkGray

New-Item -ItemType Directory -Path $DistDir -Force | Out-Null
Invoke-External -File $IsccPath -Arguments @($IssScript) -Description 'iscc installer\md-previewer.iss'

# 4. Report
$version = Get-IssVersion
$artifact = Join-Path $DistDir "MdPreviewer-Setup-$version.exe"
Write-Host ''
if (Test-Path -LiteralPath $artifact) {
    Write-Host "Installer built: $artifact" -ForegroundColor Green

    # Record which release notes went INTO this installer. The .iss bundles
    # HISTORY.md and auto-opens it after install, so editing HISTORY.md after a
    # build silently leaves the artifact shipping stale notes.
    # `release-on-main.ps1 -Verify` / `-Publish` compare this hash against the
    # current file; a content hash rather than a timestamp so a git checkout
    # that rewrites HISTORY.md byte-identically doesn't raise a false alarm.
    #
    # MIRROR: release-on-main.ps1 has the same Get-NotesHash -- keep in sync.
    $historyMd = Join-Path $PSScriptRoot 'HISTORY.md'
    if (Test-Path -LiteralPath $historyMd) {
        $hash = Get-NotesHash $historyMd
        Set-Content -LiteralPath "$artifact.notes.sha256" -Value $hash -NoNewline -Encoding ascii
    }
} else {
    Write-Warning "Expected installer at $artifact but it was not found. Check ISCC output above."
}
