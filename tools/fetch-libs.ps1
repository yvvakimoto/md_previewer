<#
.SYNOPSIS
  Download pinned third-party static libraries into assets/libs/.

.DESCRIPTION
  Pulls marked, highlight.js (+ github theme CSS), KaTeX (JS + CSS + 22 woff2
  fonts), and mermaid from cdnjs / jsdelivr at the versions documented in
  assets/THIRD_PARTY_LICENSES.txt. Idempotent by default (skips files that
  already exist); pass -Force to re-download.

  These libraries are referenced at runtime by assets/index.html and must
  exist before `cargo run` will work. The repo's .gitignore excludes them so
  they're never committed.

.PARAMETER Force
  Re-download every file, overwriting existing copies.

.PARAMETER RepoRoot
  Repo root path. Defaults to the parent of this script's directory.
#>

[CmdletBinding()]
param(
  [switch]$Force,
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'  # suppress Invoke-WebRequest progress bar (much faster)

$LibsDir = Join-Path $RepoRoot 'assets/libs'

# ---- Pinned versions ----------------------------------------------------
$MarkedVersion  = '11.1.1'
$HljsVersion    = '11.9.0'
$KatexVersion   = '0.16.11'
$MermaidVersion = '10.9.0'
$PlotlyVersion  = '2.35.2'
$JsYamlVersion  = '4.1.0'
$AbcjsVersion   = '6.6.3'
$TikzjaxVersion = '1.5.0'   # @rod2ik/tikzjax — WASM TeX for tikz-cd commutative diagrams

# ---- KaTeX font list (mirrors what KaTeX 0.16.x ships in dist/fonts/) ---
$KatexFonts = @(
  'KaTeX_AMS-Regular',
  'KaTeX_Caligraphic-Bold',
  'KaTeX_Caligraphic-Regular',
  'KaTeX_Fraktur-Bold',
  'KaTeX_Fraktur-Regular',
  'KaTeX_Main-Bold',
  'KaTeX_Main-BoldItalic',
  'KaTeX_Main-Italic',
  'KaTeX_Main-Regular',
  'KaTeX_Math-BoldItalic',
  'KaTeX_Math-Italic',
  'KaTeX_SansSerif-Bold',
  'KaTeX_SansSerif-Italic',
  'KaTeX_SansSerif-Regular',
  'KaTeX_Script-Regular',
  'KaTeX_Size1-Regular',
  'KaTeX_Size2-Regular',
  'KaTeX_Size3-Regular',
  'KaTeX_Size4-Regular',
  'KaTeX_Typewriter-Regular'
)

# ---- Download table -----------------------------------------------------
# Each entry: @{ Url = '...'; Dest = '<relative to LibsDir>' }
$Downloads = [System.Collections.Generic.List[object]]::new()

$Downloads.Add(@{
  Url  = "https://cdn.jsdelivr.net/npm/marked@$MarkedVersion/marked.min.js"
  Dest = 'marked.min.js'
})

$Downloads.Add(@{
  Url  = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/$HljsVersion/highlight.min.js"
  Dest = 'highlight.js/highlight.min.js'
})
$Downloads.Add(@{
  Url  = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/$HljsVersion/styles/github.min.css"
  Dest = 'highlight.js/github.min.css'
})

$Downloads.Add(@{
  Url  = "https://cdn.jsdelivr.net/npm/katex@$KatexVersion/dist/katex.min.js"
  Dest = 'katex/katex.min.js'
})
$Downloads.Add(@{
  Url  = "https://cdn.jsdelivr.net/npm/katex@$KatexVersion/dist/katex.min.css"
  Dest = 'katex/katex.min.css'
})
foreach ($font in $KatexFonts) {
  $Downloads.Add(@{
    Url  = "https://cdn.jsdelivr.net/npm/katex@$KatexVersion/dist/fonts/$font.woff2"
    Dest = "katex/fonts/$font.woff2"
  })
}

$Downloads.Add(@{
  Url  = "https://cdn.jsdelivr.net/npm/mermaid@$MermaidVersion/dist/mermaid.min.js"
  Dest = 'mermaid.min.js'
})

$Downloads.Add(@{
  Url  = "https://cdn.jsdelivr.net/npm/plotly.js-dist-min@$PlotlyVersion/plotly.min.js"
  Dest = 'plotly/plotly.min.js'
})

$Downloads.Add(@{
  Url  = "https://cdn.jsdelivr.net/npm/js-yaml@$JsYamlVersion/dist/js-yaml.min.js"
  Dest = 'js-yaml.min.js'
})

$Downloads.Add(@{
  Url  = "https://cdn.jsdelivr.net/npm/abcjs@$AbcjsVersion/dist/abcjs-basic-min.js"
  Dest = 'abcjs/abcjs-basic-min.js'
})

# ---- Run ----------------------------------------------------------------
Write-Host "fetch-libs: target dir = $LibsDir"
$fetched = 0
$skipped = 0

foreach ($d in $Downloads) {
  $destPath = Join-Path $LibsDir $d.Dest
  $destDir  = Split-Path -Parent $destPath
  if (-not (Test-Path $destDir)) {
    New-Item -ItemType Directory -Path $destDir -Force | Out-Null
  }

  if ((Test-Path $destPath) -and -not $Force) {
    Write-Host "  skip   : $($d.Dest)  (already present; pass -Force to refresh)"
    $skipped++
    continue
  }

  try {
    Invoke-WebRequest -Uri $d.Url -OutFile $destPath -UseBasicParsing
    $size = (Get-Item $destPath).Length
    Write-Host ("  fetched: {0,-50}  ({1:N0} bytes)" -f $d.Dest, $size)
    $fetched++
  } catch {
    Write-Error "Failed to fetch $($d.Url): $_"
    throw
  }
}

Write-Host ""
Write-Host "fetch-libs: done. fetched=$fetched skipped=$skipped total=$($Downloads.Count)"

# ---- @rod2ik/tikzjax (npm tarball, extracted) ---------------------------
# Unlike the single-file libs above, TikZJax ships a ~7.7MB dist/ tree of 400+
# files (engine JS, tex.wasm.gz, core.dump.gz, fonts/*.woff2, tex_files/*.gz)
# that would be impractical to enumerate one URL at a time, so we pull the npm
# tarball and extract its package/dist/ into assets/libs/tikzjax/dist/.
# Provides `tikzcd` / `tikz` fenced-block rendering (see assets/index.html).
$TikzDist   = Join-Path $LibsDir 'tikzjax/dist'
$TikzMarker = Join-Path $TikzDist 'tikzjax.js'
if ((Test-Path $TikzMarker) -and -not $Force) {
  Write-Host "  skip   : tikzjax/dist  (already present; pass -Force to refresh)"
} else {
  $tgzUrl = "https://registry.npmjs.org/@rod2ik/tikzjax/-/tikzjax-$TikzjaxVersion.tgz"
  $tmpTgz = Join-Path ([System.IO.Path]::GetTempPath()) "rod2ik-tikzjax-$TikzjaxVersion.tgz"
  $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "rod2ik-tikzjax-$TikzjaxVersion"
  try {
    Write-Host "fetch-libs: downloading @rod2ik/tikzjax@$TikzjaxVersion tarball ..."
    Invoke-WebRequest -Uri $tgzUrl -OutFile $tmpTgz -UseBasicParsing
    if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir }
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
    # `tar` is bundled with Windows 10+; extracts package/dist/...
    tar -xzf $tmpTgz -C $tmpDir
    if ($LASTEXITCODE -ne 0) { throw "tar extraction failed (exit $LASTEXITCODE)" }
    $srcDist = Join-Path $tmpDir 'package/dist'
    if (-not (Test-Path $srcDist)) { throw "tarball had no package/dist/ ($srcDist)" }
    if (Test-Path $TikzDist) { Remove-Item -Recurse -Force $TikzDist }
    New-Item -ItemType Directory -Path (Split-Path -Parent $TikzDist) -Force | Out-Null
    Copy-Item -Recurse -Force $srcDist $TikzDist
    # Also place the tarball's LICENSE next to dist for collect-licenses fallback.
    $srcLic = Join-Path $tmpDir 'package/LICENSE'
    if (Test-Path $srcLic) { Copy-Item -Force $srcLic (Join-Path $LibsDir 'tikzjax/LICENSE') }
    $sz = (Get-ChildItem -Recurse $TikzDist | Measure-Object Length -Sum).Sum
    Write-Host ("  fetched: {0,-50}  ({1:N0} bytes)" -f 'tikzjax/dist', $sz)
  } catch {
    Write-Error "Failed to fetch @rod2ik/tikzjax: $_"
    throw
  } finally {
    if (Test-Path $tmpTgz) { Remove-Item -Force $tmpTgz -ErrorAction SilentlyContinue }
    if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue }
  }
}
