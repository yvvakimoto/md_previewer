<#
.SYNOPSIS
  One-shot installer: populate assets/libs/ on a fresh clone.

.DESCRIPTION
  Run this once after cloning the repo (and again whenever an external lib
  version is bumped). It will:

    1. Download static third-party libs (marked, mermaid, KaTeX, highlight.js)
       via tools/fetch-libs.ps1.
    2. npm install + npm run build inside tools/build-marp/   -> marp.iife.js
    3. npm install + npm run build inside tools/build-editor/ -> editor.iife.js
    4. (optional, -Licenses) regenerate assets/THIRD_PARTY_LICENSES.txt.

  After this, `cargo build --release` and `cargo run --release` work.

.PARAMETER Force
  Forwarded to fetch-libs.ps1 — re-downloads every static file even if present.

.PARAMETER SkipNode
  Skip the npm-based steps (marp / editor builds, license regen). Useful when
  you only want to refresh the CDN-sourced libs and don't have Node available.

.PARAMETER Licenses
  After the npm builds, run tools/collect-licenses.ps1 to regenerate
  assets/THIRD_PARTY_LICENSES.txt. Requires the npm trees to exist.
#>

[CmdletBinding()]
param(
  [switch]$Force,
  [switch]$SkipNode,
  [switch]$Licenses
)

$ErrorActionPreference = 'Stop'

$ScriptDir = $PSScriptRoot
$RepoRoot  = Split-Path -Parent $ScriptDir

function Write-Header {
  param([string]$Title)
  Write-Host ''
  Write-Host '================================================================' -ForegroundColor Cyan
  Write-Host (" {0}" -f $Title) -ForegroundColor Cyan
  Write-Host '================================================================' -ForegroundColor Cyan
}

function Invoke-NpmStep {
  param([string]$ProjectDir, [string]$Label)
  Write-Header "$Label  ($ProjectDir)"
  Push-Location $ProjectDir
  try {
    Write-Host '> npm install'
    & npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed in $ProjectDir (exit $LASTEXITCODE)" }
    Write-Host '> npm run build'
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed in $ProjectDir (exit $LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
}

# ---- Step 1: static libs -----------------------------------------------
Write-Header '[1/4] fetch static libs (marked / mermaid / KaTeX / highlight.js)'
$fetchArgs = @{ RepoRoot = $RepoRoot }
if ($Force) { $fetchArgs['Force'] = $true }
& (Join-Path $ScriptDir 'fetch-libs.ps1') @fetchArgs

# ---- npm-based steps ---------------------------------------------------
if ($SkipNode) {
  Write-Host ''
  Write-Host '[2-4] skipped (-SkipNode)'
  Write-Host ''
  Write-Host 'install-deps: done (fetch-only).'
  return
}

$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) {
  Write-Error @'
npm not found on PATH. Install Node.js (https://nodejs.org/) and re-run, or
pass -SkipNode to populate only the CDN-sourced static libs.
'@
  exit 1
}

# Step 2: marp
Invoke-NpmStep -ProjectDir (Join-Path $RepoRoot 'tools/build-marp')   -Label '[2/4] build marp IIFE bundle'

# Step 3: editor
Invoke-NpmStep -ProjectDir (Join-Path $RepoRoot 'tools/build-editor') -Label '[3/4] build editor IIFE bundle'

# Step 4: licenses (optional)
if ($Licenses) {
  Write-Header '[4/4] regenerate THIRD_PARTY_LICENSES.txt'
  & (Join-Path $ScriptDir 'collect-licenses.ps1') -RepoRoot $RepoRoot
} else {
  Write-Host ''
  Write-Host '[4/4] license regen skipped (pass -Licenses to run tools/collect-licenses.ps1)'
}

Write-Host ''
Write-Host 'install-deps: done.' -ForegroundColor Green
Write-Host 'Next: cargo build --release  (then copy assets/* -> target/release/assets/ per CLAUDE.md)'
