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
