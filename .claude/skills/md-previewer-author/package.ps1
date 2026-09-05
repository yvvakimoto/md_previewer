<#
.SYNOPSIS
  Package this skill folder into a distributable <skill-name>.skill file.

.DESCRIPTION
  Produces a .skill archive (a ZIP) byte-compatible with skill-creator's
  scripts/package_skill.py: every entry path is relative to the skill's PARENT
  directory, so the archive contains a single top-level "<skill-name>/" folder.
  Build artifacts are excluded (__pycache__, node_modules, *.pyc, *.skill, .DS_Store)
  and a root-level evals/ directory is dropped, matching the Python packager.

  Before zipping, the bundled samples/ snapshot is refreshed from the md_previewer
  repo's samples/ (../../../samples) when that path exists, so the package always ships
  the current samples. Disable with -NoRefreshSamples. The skill keeps a committed
  samples/ snapshot too, so it stays self-contained when used outside the repo.

  Note the installer does NOT use that snapshot: installer/md-previewer.iss sources
  the skill's samples/ straight from the repo's samples/, so the installed copy cannot
  go stale. The committed snapshot exists for repo-external use and for this packager;
  tools/preview-harness/skillcheck.py fails if it drifts from the repo's samples/.

  Lightweight validation (SKILL.md present; frontmatter has name + description; name is
  kebab-case; description <= 1024 chars with no angle brackets) runs first, mirroring
  scripts/quick_validate.py, so a bad skill fails fast before an archive is written.

.PARAMETER SkillPath
  Path to the skill folder. Defaults to the directory containing this script.

.PARAMETER OutputDir
  Directory to write the .skill file into. Defaults to the current directory.

.PARAMETER NoRefreshSamples
  Skip refreshing samples/ from the repo; package the committed snapshot as-is.

.EXAMPLE
  pwsh -File package.ps1
  # -> .\md-previewer-author.skill

.EXAMPLE
  pwsh -File package.ps1 -OutputDir ..\..\..\dist
#>
[CmdletBinding()]
param(
    [string]$SkillPath = $PSScriptRoot,
    [string]$OutputDir = (Get-Location).Path,
    [switch]$NoRefreshSamples
)

$ErrorActionPreference = 'Stop'

$skill     = (Resolve-Path -LiteralPath $SkillPath).Path
$skillName = Split-Path $skill -Leaf
$parent    = Split-Path $skill -Parent

# ---- validate (mirrors scripts/quick_validate.py) ----
$skillMd = Join-Path $skill 'SKILL.md'
if (-not (Test-Path -LiteralPath $skillMd)) { throw "SKILL.md not found in $skill" }
$md = Get-Content -Raw -LiteralPath $skillMd
if ($md -notmatch '^---') { throw 'SKILL.md has no YAML frontmatter' }
$fm = [regex]::Match($md, '(?s)^---\r?\n(.*?)\r?\n---').Groups[1].Value
if (-not $fm) { throw 'SKILL.md frontmatter is malformed' }
$name = [regex]::Match($fm, '(?m)^name:\s*(.+?)\s*$').Groups[1].Value
$desc = [regex]::Match($fm, '(?ms)^description:\s*(.+?)\s*(?:\r?\n\w+:|\z)').Groups[1].Value
if (-not $name) { throw "Missing 'name' in SKILL.md frontmatter" }
if (-not $desc) { throw "Missing 'description' in SKILL.md frontmatter" }
if ($name -notmatch '^[a-z0-9-]+$' -or $name -match '(^-|-$|--)') {
    throw "Name '$name' must be kebab-case (lowercase letters, digits, single hyphens)"
}
if ($desc.Length -gt 1024) { throw "Description is too long ($($desc.Length) chars; max 1024)" }
if ($desc -match '[<>]') { throw 'Description cannot contain angle brackets (< or >)' }
Write-Host "Validated: $name"

# ---- refresh bundled samples from the repo, if available ----
if (-not $NoRefreshSamples) {
    $repoSamples = Join-Path $skill '..\..\..\samples'
    if (Test-Path -LiteralPath $repoSamples) {
        $repoSamples = (Resolve-Path -LiteralPath $repoSamples).Path
        $dstSamples  = Join-Path $skill 'samples'
        if (Test-Path -LiteralPath $dstSamples) { Remove-Item -Recurse -Force -LiteralPath $dstSamples }
        Copy-Item -Recurse -Force -LiteralPath $repoSamples -Destination $dstSamples
        Write-Host "Refreshed samples/ from $repoSamples"
    }
}

# ---- exclusions (mirror package_skill.py) ----
$excludeDirs     = @('__pycache__', 'node_modules')
$excludeFiles    = @('.DS_Store')
$excludeGlobs    = @('*.pyc', '*.skill')   # *.skill: never pack a previously built archive into the new one
$rootExcludeDirs = @('evals')   # excluded only directly under the skill root

function Test-Excluded([string]$relPath) {
    $parts = $relPath -split '[\\/]'
    foreach ($p in $parts) { if ($excludeDirs -contains $p) { return $true } }
    # parts[0] is the skill folder name; parts[1] (if any) is the first subdir
    if ($parts.Count -gt 1 -and ($rootExcludeDirs -contains $parts[1])) { return $true }
    $leaf = $parts[-1]
    if ($excludeFiles -contains $leaf) { return $true }
    foreach ($g in $excludeGlobs) { if ($leaf -like $g) { return $true } }
    return $false
}

# ---- output path ----
$null    = New-Item -ItemType Directory -Force -Path $OutputDir
$outFile = Join-Path ((Resolve-Path -LiteralPath $OutputDir).Path) "$skillName.skill"
if (Test-Path -LiteralPath $outFile) { Remove-Item -Force -LiteralPath $outFile }

# ---- build the .skill (zip) ----
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($outFile, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($f in Get-ChildItem -LiteralPath $skill -Recurse -File) {
        $rel = $f.FullName.Substring($parent.Length).TrimStart('\', '/')  # e.g. md-previewer-author\SKILL.md
        if (Test-Excluded $rel) { Write-Host "  Skipped: $rel"; continue }
        $entry = $rel -replace '\\', '/'                                  # ZIP entries use forward slashes
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $entry)
        Write-Host "  Added:   $entry"
    }
}
finally {
    $zip.Dispose()
}

$sizeKb = [math]::Round((Get-Item -LiteralPath $outFile).Length / 1KB, 1)
Write-Host ""
Write-Host "Packaged skill -> $outFile  ($sizeKb KB)"
