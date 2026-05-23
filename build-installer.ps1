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
} else {
    Write-Warning "Expected installer at $artifact but it was not found. Check ISCC output above."
}
