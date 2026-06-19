<#
.SYNOPSIS
    main ブランチ更新時の自動リリース処理。

.DESCRIPTION
    前回リリースタグ (v*) 以降のコミットからバージョンを判定し、
    Cargo.toml / installer/md-previewer.iss / HISTORY.md を更新、
    インストーラーをビルドし、成功時にコミット + タグ付けする。

    通常は tools/hooks/post-merge から自動呼び出しされる。

.PARAMETER Bump
    バンプ種別を明示指定 (major / minor / patch)。省略時はコミットメッセージから判定。

.PARAMETER DryRun
    ファイル更新・ビルド・コミット・タグを行わず、判定結果と差分予定のみ表示。

.PARAMETER SkipBuild
    インストーラービルドを省略（ファイル更新・コミット・タグは行う）。検証用。

.PARAMETER Force
    main ブランチ判定および作業ツリー dirty 判定のガードを無視（検証用）。
#>
param(
    [ValidateSet('major', 'minor', 'patch')]
    [string]$Bump,
    [switch]$DryRun,
    [switch]$SkipBuild,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# git は UTF-8 で出力するため、ネイティブコマンドの stdout を UTF-8 として解釈させる。
# これが無いと日本語ロケール (CP932) で git log の出力が文字化けし、HISTORY.md に
# 化けた文字列が書き込まれてしまう。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$RepoRoot   = Split-Path -Parent $PSScriptRoot
$CargoToml  = Join-Path $RepoRoot 'Cargo.toml'
$IssScript  = Join-Path $RepoRoot 'installer\md-previewer.iss'
$HistoryMd  = Join-Path $RepoRoot 'HISTORY.md'
$BuildInst  = Join-Path $RepoRoot 'build-installer.ps1'

function Write-Step($msg)  { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Skip($msg)  { Write-Host "--- $msg" -ForegroundColor DarkGray }

# git をリポジトリルートで実行するためのヘルパ
function Invoke-Git {
    param([Parameter(Mandatory)][string[]]$GitArgs)
    & git -C $RepoRoot @GitArgs
}

# ------------------------------------------------------------------
# 1. ガード: main ブランチ上か / 作業ツリーがクリーンか
# ------------------------------------------------------------------
$branch = (Invoke-Git -GitArgs @('rev-parse', '--abbrev-ref', 'HEAD')).Trim()
if ($branch -ne 'main' -and -not $Force) {
    Write-Skip "現在のブランチは '$branch' です (main ではないため何もしません)。"
    exit 0
}

$status = Invoke-Git -GitArgs @('status', '--porcelain')
if ($status -and -not $Force) {
    Write-Warning "作業ツリーに未コミットの変更があるためリリースを中止します。"
    exit 0
}

# ------------------------------------------------------------------
# 2. 前回リリースタグの取得
# ------------------------------------------------------------------
$lastTag = ''
try {
    $lastTag = (Invoke-Git -GitArgs @('describe', '--tags', '--abbrev=0', '--match', 'v*')).Trim()
} catch {
    $lastTag = ''
}

if ($lastTag) {
    $range = "$lastTag..HEAD"
    if ($lastTag -notmatch '^v(\d+)\.(\d+)\.(\d+)$') {
        Write-Warning "最新タグ '$lastTag' が vX.Y.Z 形式ではありません。中止します。"
        exit 1
    }
    $baseMajor = [int]$Matches[1]; $baseMinor = [int]$Matches[2]; $basePatch = [int]$Matches[3]
} else {
    # タグが無い場合は Cargo.toml の現在バージョンを基準に全コミットを対象
    $range = 'HEAD'
    $cargoVer = (Select-String -LiteralPath $CargoToml -Pattern '^\s*version\s*=\s*"([^"]+)"' | Select-Object -First 1).Matches[0].Groups[1].Value
    if ($cargoVer -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
        Write-Warning "Cargo.toml のバージョン '$cargoVer' を解釈できません。中止します。"
        exit 1
    }
    $baseMajor = [int]$Matches[1]; $baseMinor = [int]$Matches[2]; $basePatch = [int]$Matches[3]
    Write-Skip "リリースタグが見つからないため Cargo.toml ($cargoVer) を基準にします。"
}

# ------------------------------------------------------------------
# 3. コミット範囲の取得 (マージコミット除外)
# ------------------------------------------------------------------
$subjects = @(Invoke-Git -GitArgs @('log', '--no-merges', '--format=%s', $range) | Where-Object { $_ -and $_.Trim() })
if ($subjects.Count -eq 0) {
    Write-Skip "前回リリース ($lastTag) 以降に新しいコミットがありません。何もしません。"
    exit 0
}

# ------------------------------------------------------------------
# 4. バンプ判定
# ------------------------------------------------------------------
$breakingRe = '破壊的|BREAKING|!:'
$featureRe  = '追加|機能|対応|実装|新規|feat'

if (-not $Bump) {
    if ($subjects -match $breakingRe)      { $Bump = 'major' }
    elseif ($subjects -match $featureRe)   { $Bump = 'minor' }
    else                                   { $Bump = 'patch' }
}

switch ($Bump) {
    'major' { $newMajor = $baseMajor + 1; $newMinor = 0;             $newPatch = 0 }
    'minor' { $newMajor = $baseMajor;     $newMinor = $baseMinor + 1; $newPatch = 0 }
    'patch' { $newMajor = $baseMajor;     $newMinor = $baseMinor;     $newPatch = $basePatch + 1 }
}
$newVersion = "$newMajor.$newMinor.$newPatch"
$newTag     = "v$newVersion"

Write-Step "前回タグ: $(if ($lastTag) { $lastTag } else { '(なし)' })  /  バンプ: $Bump  ->  新バージョン: $newVersion"
Write-Host ("対象コミット {0} 件:" -f $subjects.Count) -ForegroundColor DarkGray
$subjects | ForEach-Object { Write-Host "    - $_" -ForegroundColor DarkGray }

# ------------------------------------------------------------------
# 5. HISTORY.md 用箇条書き (雑務コミットを除外)
# ------------------------------------------------------------------
$choreRe = 'バージョン|リリース|^WIP|^Merge|version|release'
$bullets = $subjects | Where-Object { $_ -notmatch $choreRe } | ForEach-Object { "- $_" }
if ($bullets.Count -eq 0) { $bullets = @("- メンテナンス更新") }

if ($DryRun) {
    Write-Host ''
    Write-Step "[DryRun] 以下を更新予定 (実際には変更しません):"
    Write-Host "  Cargo.toml version          -> $newVersion"
    Write-Host "  installer AppVersion        -> $newVersion"
    Write-Host "  HISTORY.md 先頭に追記:"
    Write-Host "    ## $newTag"
    $bullets | ForEach-Object { Write-Host "    $_" }
    Write-Host ''
    Write-Step "[DryRun] その後 build-installer.ps1 を実行し、成功時に commit + tag '$newTag' します。"
    exit 0
}

# ------------------------------------------------------------------
# 6. 3 箇所のバージョン書き換え
# ------------------------------------------------------------------
Write-Step "バージョンを $newVersion に更新します。"

# Cargo.toml: 最初の version 行のみ (EOL を保つため raw 置換)
$cargoText = Get-Content -LiteralPath $CargoToml -Raw
$cargoNew  = [regex]::Replace($cargoText, '(?m)^(\s*version\s*=\s*")[^"]+(")', "`${1}$newVersion`${2}", 1)
if ($cargoNew -eq $cargoText) { throw "Cargo.toml の version 行が見つかりませんでした。" }
Set-Content -LiteralPath $CargoToml -Value $cargoNew -NoNewline -Encoding utf8NoBOM

# installer/md-previewer.iss: #define AppVersion "..."
$issText = Get-Content -LiteralPath $IssScript -Raw
$issNew  = [regex]::Replace($issText, '(#define\s+AppVersion\s+")[^"]+(")', "`${1}$newVersion`${2}", 1)
if ($issNew -eq $issText) { throw "installer/md-previewer.iss の AppVersion を更新できませんでした。" }
Set-Content -LiteralPath $IssScript -Value $issNew -NoNewline -Encoding utf8NoBOM

# HISTORY.md: 導入文の直後 (最初の '## v' の手前) に新セクションを挿入。
# EOL を保つため raw 文字列で操作する。
$histText = Get-Content -LiteralPath $HistoryMd -Raw
$nl       = if ($histText -match "`r`n") { "`r`n" } else { "`n" }
$section  = (@("## $newTag", "") + $bullets + @("", "")) -join $nl
$m        = [regex]::Match($histText, '(?m)^##\s+v')
if ($m.Success) {
    $histNew = $histText.Substring(0, $m.Index) + $section + $histText.Substring($m.Index)
} else {
    # 既存エントリが無ければ末尾に追記
    $sep = if ($histText.EndsWith($nl)) { '' } else { $nl }
    $histNew = $histText + $sep + $section
}
Set-Content -LiteralPath $HistoryMd -Value $histNew -NoNewline -Encoding utf8NoBOM

# ------------------------------------------------------------------
# 7. インストーラービルド (成功後にのみ commit / tag)
# ------------------------------------------------------------------
if ($SkipBuild) {
    Write-Skip "-SkipBuild 指定のためインストーラービルドを省略します。"
} else {
    Write-Step "インストーラーをビルドします (build-installer.ps1)..."
    $env:MDP_IN_RELEASE = '1'    # フック再入防止
    try {
        & pwsh -NoProfile -File $BuildInst
        $buildExit = $LASTEXITCODE
    } finally {
        Remove-Item Env:\MDP_IN_RELEASE -ErrorAction SilentlyContinue
    }
    if ($buildExit -ne 0) {
        Write-Warning "ビルドに失敗しました (exit $buildExit)。バージョン変更は作業ツリーに残しています。commit / tag は行いません。"
        exit 1
    }
}

# ------------------------------------------------------------------
# 8. コミット + タグ (変更ファイルのみ明示的にステージ)
# ------------------------------------------------------------------
Write-Step "リリースコミットとタグ '$newTag' を作成します。"
Invoke-Git -GitArgs @('add', '--', 'Cargo.toml', 'Cargo.lock', 'installer/md-previewer.iss', 'HISTORY.md')
Invoke-Git -GitArgs @('commit', '-m', "リリース $newTag")
Invoke-Git -GitArgs @('tag', $newTag)

# ------------------------------------------------------------------
# 9. 報告 (push は既定で行わない)
# ------------------------------------------------------------------
$artifact = Join-Path $RepoRoot "dist\MdPreviewer-Setup-$newVersion.exe"
Write-Host ''
Write-Host "リリース $newTag を作成しました。" -ForegroundColor Green
if (-not $SkipBuild) {
    if (Test-Path -LiteralPath $artifact) {
        Write-Host "  インストーラー: $artifact" -ForegroundColor Green
    } else {
        Write-Warning "  期待したインストーラー $artifact が見つかりません。"
    }
}

if ($env:MDP_RELEASE_PUSH -eq '1') {
    Write-Step "MDP_RELEASE_PUSH=1 のため push します。"
    Invoke-Git -GitArgs @('push', 'origin', 'main')
    Invoke-Git -GitArgs @('push', 'origin', $newTag)
} else {
    Write-Host ''
    Write-Host "公開するには次を実行してください:" -ForegroundColor Yellow
    Write-Host "    git push origin main; git push origin $newTag" -ForegroundColor Yellow
    Write-Host "HISTORY.md を手直ししたい場合は push 前に編集し、'git commit --amend' / タグ貼り直しが可能です。" -ForegroundColor DarkGray
}
