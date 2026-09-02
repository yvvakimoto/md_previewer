param(
    [switch]$DebugBuild,
    [switch]$Clean,
    [switch]$ForceDeps,
    [switch]$SkipAssetCopy
)

$ErrorActionPreference = 'Stop'

$RepoRoot = $PSScriptRoot
$AssetsDir = Join-Path $RepoRoot 'assets'
$LibsDir = Join-Path $AssetsDir 'libs'
$IconPath = Join-Path $AssetsDir 'icon.ico'
$ToolsDir = Join-Path $RepoRoot 'tools'
$InstallDepsScript = Join-Path $ToolsDir 'install-deps.ps1'
$MakeIconScript = Join-Path $ToolsDir 'make-icon\make_icon.py'

# --manifest-path, not a bare `cargo build`: cargo resolves Cargo.toml from the
# CURRENT directory, so without it this script only works when the caller's cwd
# happens to be the repo root. ..\nwc-addon\build-full-installer.ps1 invokes it
# by absolute path from its own directory, where a bare `cargo build` fails.
$ManifestArg = @('--manifest-path', (Join-Path $RepoRoot 'Cargo.toml'))
if ($DebugBuild) {
    $BuildProfile = 'debug'
    $CargoArgs = @('build') + $ManifestArg
} else {
    $BuildProfile = 'release'
    $CargoArgs = @('build', '--release') + $ManifestArg
}
$TargetDir = Join-Path $RepoRoot "target\$BuildProfile"
$TargetAssetsDir = Join-Path $TargetDir 'assets'
$ExePath = Join-Path $TargetDir 'md-previewer.exe'

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

# 1. Clean
if ($Clean) {
    Write-Host '==> Cleaning target\ and assets\libs\' -ForegroundColor Cyan
    Invoke-External -File 'cargo' -Arguments (@('clean') + $ManifestArg) -Description 'cargo clean'
    if (Test-Path $LibsDir) {
        Remove-Item -LiteralPath $LibsDir -Recurse -Force
    }
}

# 2. Dependencies (assets\libs\)
# One sentinel PER fetched/built library, not a representative sample. A library
# missing from this list is a library install-deps.ps1 will never be re-run for on
# a checkout whose assets\libs\ predates it - the script just prints "already
# populated", and the copy below then ships a tree without it. That is exactly how
# a build came to 404 on libs/feynmark/feynmark.min.js. Add the new path here
# whenever tools/fetch-libs.ps1 or a tools/build-* project gains an output.
$libsSentinels = @(
    'libs\editor\editor.iife.js',
    'libs\marp\marp.iife.js',
    'libs\markwhen\markwhen.iife.js',
    'libs\katex\katex.min.js',
    'libs\marked.min.js',
    'libs\mermaid.min.js',
    'libs\highlight.js\highlight.min.js',
    'libs\plotly\plotly.min.js',
    'libs\js-yaml.min.js',
    'libs\abcjs\abcjs-basic-min.js',
    'libs\feynmark\feynmark.min.js',
    'libs\tikzjax\dist\tikzjax.js'
) | ForEach-Object { Join-Path $AssetsDir $_ }

$libsMissing = $libsSentinels | Where-Object { -not (Test-Path -LiteralPath $_) }

if ($ForceDeps -or $libsMissing) {
    if ($ForceDeps) {
        Write-Host '==> Running install-deps.ps1 -Force (forced)' -ForegroundColor Cyan
        Invoke-External -File 'pwsh' -Arguments @('-NoProfile', '-File', $InstallDepsScript, '-Force') -Description 'install-deps.ps1 -Force'
    } else {
        Write-Host '==> Running install-deps.ps1 (missing libs detected)' -ForegroundColor Cyan
        foreach ($m in $libsMissing) { Write-Host "    missing: $m" }
        Invoke-External -File 'pwsh' -Arguments @('-NoProfile', '-File', $InstallDepsScript) -Description 'install-deps.ps1'
    }
} else {
    Write-Host '==> assets\libs\ already populated, skipping install-deps.ps1' -ForegroundColor DarkGray
}

# 3. Icon
if (-not (Test-Path -LiteralPath $IconPath)) {
    $python = Get-Command python -ErrorAction SilentlyContinue
    if (-not $python) { $python = Get-Command py -ErrorAction SilentlyContinue }
    if ($python) {
        Invoke-External -File $python.Source -Arguments @($MakeIconScript) -Description 'make_icon.py'
    } else {
        Write-Warning 'python not found on PATH; skipping icon generation. cargo build will fail if assets\icon.ico is missing.'
    }
} else {
    Write-Host '==> assets\icon.ico exists, skipping icon generation' -ForegroundColor DarkGray
}

# 4. cargo build
Invoke-External -File 'cargo' -Arguments $CargoArgs -Description "cargo $($CargoArgs -join ' ')"

# 5. Copy assets next to the exe
if (-not $SkipAssetCopy) {
    Write-Host "==> Syncing assets\ -> $TargetAssetsDir" -ForegroundColor Cyan
    if (Test-Path -LiteralPath $TargetAssetsDir) {
        Remove-Item -LiteralPath $TargetAssetsDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $TargetAssetsDir -Force | Out-Null
    Copy-Item -Path (Join-Path $AssetsDir '*') -Destination $TargetAssetsDir -Recurse -Force
} else {
    Write-Host '==> -SkipAssetCopy specified, leaving target\...\assets\ untouched' -ForegroundColor DarkGray
}

Write-Host ''
Write-Host "Build complete: $ExePath" -ForegroundColor Green
