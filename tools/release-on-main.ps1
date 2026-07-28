<#
.SYNOPSIS
    main ブランチ更新時の自動リリース処理 (二段階)。

.DESCRIPTION
    リリースは 2 段階に分かれている。HISTORY.md はインストーラーに同梱され
    インストール直後に自動表示されるため、生成されたままの下書き (コミット件名の
    羅列) を公開してはならない。そこで「下書き生成」と「確定」を分離し、
    レビューを飛ばせないようにしている。

    第 1 段階 (既定 / tools/hooks/post-merge から自動呼び出し):
        前回リリースタグ以降のコミットからバージョンを判定し、
        Cargo.toml / installer/md-previewer.iss / HISTORY.md を更新する。
        HISTORY.md には利用者向け候補を箇条書きとして、内部作業を参考情報
        (HTML コメント) として書き出し、先頭にレビューマーカーを置く。
        ビルド・コミット・タグは行わない。

    第 2 段階 (-Finalize):
        レビューマーカーが消えていることを確認し、バージョン 3 箇所の整合性を
        検証したうえでインストーラーをビルドし、コミット + タグを作成する。
        マーカーが残っていれば中止するので、未レビューのまま確定できない。

    -Verify:
        いつでも実行できる機械的な検査 (バージョン整合性 / レビューマーカー /
        タグ位置 / インストーラーが HISTORY.md より新しいか)。push 前の確認用。

.PARAMETER Bump
    バンプ種別を明示指定 (major / minor / patch)。省略時はコミットメッセージから判定。

.PARAMETER DryRun
    第 1 段階の判定結果と書き込み予定内容のみ表示し、ファイルは変更しない。

.PARAMETER Finalize
    第 2 段階を実行 (レビュー後の確定: ビルド + コミット + タグ)。

.PARAMETER Verify
    公開前の機械的検査のみ実行。

.PARAMETER SkipBuild
    -Finalize 時にインストーラービルドを省略 (検証用)。

.PARAMETER Force
    main ブランチ判定・作業ツリー判定のガードを無視 (検証用)。
#>
param(
    [ValidateSet('major', 'minor', 'patch')]
    [string]$Bump,
    [switch]$DryRun,
    [switch]$Finalize,
    [switch]$Verify,
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

# HISTORY.md の下書きに置くレビューマーカー。この文字列が残っている限り
# -Finalize は確定を拒否する。HTML コメントなので万一残っても描画はされない。
$ReviewToken = 'TODO(release-notes)'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Skip($msg) { Write-Host "--- $msg" -ForegroundColor DarkGray }
function Write-Ok($msg)   { Write-Host "  OK   $msg" -ForegroundColor Green }
function Write-Ng($msg)   { Write-Host "  NG   $msg" -ForegroundColor Red }

function Invoke-Git {
    param([Parameter(Mandatory)][string[]]$GitArgs)
    & git -C $RepoRoot @GitArgs
}

function Get-FileText($path) { Get-Content -LiteralPath $path -Raw }
function Set-FileText($path, $text) {
    Set-Content -LiteralPath $path -Value $text -NoNewline -Encoding utf8NoBOM
}

function Get-CargoVersion {
    $m = [regex]::Match((Get-FileText $CargoToml), '(?m)^\s*version\s*=\s*"([^"]+)"')
    if (-not $m.Success) { throw "Cargo.toml の version 行が見つかりません。" }
    $m.Groups[1].Value
}

function Get-IssVersion {
    $m = [regex]::Match((Get-FileText $IssScript), '#define\s+AppVersion\s+"([^"]+)"')
    if (-not $m.Success) { throw "installer/md-previewer.iss の AppVersion が見つかりません。" }
    $m.Groups[1].Value
}

function Test-ReviewPending {
    (Get-FileText $HistoryMd).Contains($ReviewToken)
}

# ------------------------------------------------------------------
# コミット件名の分類
# ------------------------------------------------------------------
# 完全に無視するもの (このスクリプト自身が作るリリースコミット等)。
# 以前は 'バージョン|リリース|version|release' を件名のどこにでも当てていたため、
# 「feat: リリースノート生成に対応」のような正当な件名まで落ちる可能性があった。
# 先頭アンカーにして誤除去を防いでいる。
$SkipRe = '^リリース\s+v?\d|^バージョン|^WIP\b|^Merge\b|^chore(\([^)]*\))?:|^release[:\s]|^version[:\s]'

# 利用者に見えない作業。conventional prefix で判定する (このリポジトリは
# feat:/fix:/refactor:/test:/docs: を一貫して使っている)。
$InternalRe = '^(refactor|test|docs|chore|build|ci|style)(\([^)]*\))?!?:'

# 利用者に見える変更。prefix 無しの自由記述もこちらに寄せる (隠すより出す)。
$UserRe = '^(feat|fix|perf)(\([^)]*\))?!?:'

function Remove-CommitPrefix($subject) {
    $subject -replace '^(feat|fix|perf|refactor|test|docs|chore|build|ci|style)(\([^)]*\))?!?:\s*', ''
}

function Split-Subjects($subjects) {
    $user = @(); $internal = @()
    foreach ($s in $subjects) {
        if ($s -match $SkipRe)          { continue }
        if ($s -match $InternalRe)      { $internal += $s; continue }
        $user += $s                     # UserRe に一致、または prefix 無し
    }
    [pscustomobject]@{ User = $user; Internal = $internal }
}

# ------------------------------------------------------------------
# -Verify: 公開前の機械的検査
# ------------------------------------------------------------------
function Invoke-Verify {
    Write-Step "リリース状態を検査します。"
    $ok = $true

    $cargoVer = Get-CargoVersion
    $issVer   = Get-IssVersion
    if ($cargoVer -eq $issVer) {
        Write-Ok "バージョン一致: Cargo.toml / installer = $cargoVer"
    } else {
        Write-Ng "バージョン不一致: Cargo.toml=$cargoVer installer=$issVer"; $ok = $false
    }

    $hist = Get-FileText $HistoryMd
    if ($hist -match "(?m)^##\s+v$([regex]::Escape($cargoVer))\s*$") {
        Write-Ok "HISTORY.md に '## v$cargoVer' の節がある"
    } else {
        Write-Ng "HISTORY.md に '## v$cargoVer' の節が無い"; $ok = $false
    }

    if (Test-ReviewPending) {
        Write-Ng "HISTORY.md にレビューマーカー ($ReviewToken) が残っている — 利用者向けに書き換えてください"
        $ok = $false
    } else {
        Write-Ok "レビューマーカーは残っていない"
    }

    # 未リリース節が残っていないか (下書きと重複しがち)
    if ($hist -match '(?m)^##\s*(未リリース|Unreleased)\s*$') {
        Write-Ng "'## 未リリース' 節が残っている — リリース節に畳み込んでください"; $ok = $false
    } else {
        Write-Ok "'## 未リリース' 節は残っていない"
    }

    $tag = "v$cargoVer"
    $tagCommit  = (Invoke-Git -GitArgs @('rev-list', '-n', '1', $tag) 2>$null)
    $headCommit = (Invoke-Git -GitArgs @('rev-parse', 'HEAD')).Trim()
    if (-not $tagCommit) {
        Write-Ng "タグ $tag が存在しない (-Finalize 未実行?)"; $ok = $false
    } elseif ($tagCommit.Trim() -eq $headCommit) {
        Write-Ok "タグ $tag が HEAD を指している"
    } else {
        # HEAD より後ろにコミットを積んでいれば正常なので、警告に留める。
        $isAncestor = $null
        & git -C $RepoRoot merge-base --is-ancestor $tag HEAD 2>$null
        $isAncestor = ($LASTEXITCODE -eq 0)
        if ($isAncestor) {
            Write-Ok "タグ $tag は HEAD の祖先 (リリース後に追加コミットあり)"
        } else {
            Write-Ng "タグ $tag が HEAD の履歴上にない"; $ok = $false
        }
    }

    # インストーラーに同梱されたリリースノートが現在の HISTORY.md と一致するか。
    # (installer/md-previewer.iss が HISTORY.md を {app} に同梱し、[Run] で自動表示する
    #  ため、ビルド後に HISTORY.md を編集すると成果物だけ古いままになる)
    # タイムスタンプ比較ではなく内容ハッシュで判定する — git checkout などで
    # 内容が同一のまま mtime だけ動くケースを誤検知しないため。
    # ハッシュは build-installer.ps1 がビルド成功時に .notes.sha256 として記録する。
    $artifact = Join-Path $RepoRoot "dist\MdPreviewer-Setup-$cargoVer.exe"
    $stamp    = "$artifact.notes.sha256"
    $rebuild  = "       pwsh -NoProfile -File build-installer.ps1 -SkipBuild -SkipLicenses"
    if (-not (Test-Path -LiteralPath $artifact)) {
        Write-Ng "インストーラー $artifact が無い"; $ok = $false
    } elseif (-not (Test-Path -LiteralPath $stamp)) {
        # 記録が無い (このスタンプ機構より前に作られた成果物)。timestamp に退避。
        $exeTime  = (Get-Item -LiteralPath $artifact).LastWriteTimeUtc
        $histTime = (Get-Item -LiteralPath $HistoryMd).LastWriteTimeUtc
        if ($exeTime -ge $histTime) {
            Write-Ok "インストーラーは HISTORY.md より新しい (同梱ノート記録なし: 時刻で判定)"
        } else {
            Write-Ng "インストーラーが HISTORY.md より古い — 同梱ノートが古い可能性。`n$rebuild"
            $ok = $false
        }
    } else {
        $want = (Get-Content -LiteralPath $stamp -Raw).Trim()
        $have = (Get-FileHash -LiteralPath $HistoryMd -Algorithm SHA256).Hash
        if ($want -eq $have) {
            Write-Ok "インストーラー同梱のリリースノートが現在の HISTORY.md と一致"
        } else {
            Write-Ng "インストーラー同梱のリリースノートが古い (HISTORY.md がビルド後に変更されています)。`n$rebuild"
            $ok = $false
        }
    }

    Write-Host ''
    if ($ok) {
        Write-Host "検査に合格しました。公開するには:" -ForegroundColor Green
        Write-Host "    git push origin main; git push origin v$cargoVer" -ForegroundColor Yellow
        exit 0
    }
    Write-Warning "検査に失敗しました。上の NG を解消してください。"
    exit 1
}

# ------------------------------------------------------------------
# -Finalize: レビュー後の確定 (ビルド + コミット + タグ)
# ------------------------------------------------------------------
function Invoke-Finalize {
    $branch = (Invoke-Git -GitArgs @('rev-parse', '--abbrev-ref', 'HEAD')).Trim()
    if ($branch -ne 'main' -and -not $Force) {
        Write-Warning "現在のブランチは '$branch' です (main で実行してください)。"
        exit 1
    }

    if (Test-ReviewPending) {
        Write-Warning @"
HISTORY.md にレビューマーカーが残っています。確定を中止しました。

  HISTORY.md の '$ReviewToken' コメントブロックを読み、箇条書きを
  利用者向けに書き換えてからコメントを削除し、再度 -Finalize してください。
  (HISTORY.md はインストーラーに同梱され、インストール直後に自動表示されます)
"@
        exit 1
    }

    $version = Get-CargoVersion
    $issVer  = Get-IssVersion
    if ($version -ne $issVer) {
        Write-Warning "バージョンが一致しません (Cargo.toml=$version installer=$issVer)。中止します。"
        exit 1
    }
    $tag = "v$version"

    $hist = Get-FileText $HistoryMd
    if ($hist -notmatch "(?m)^##\s+v$([regex]::Escape($version))\s*$") {
        Write-Warning "HISTORY.md に '## $tag' の節が見つかりません。中止します。"
        exit 1
    }
    if ($hist -match '(?m)^##\s*(未リリース|Unreleased)\s*$') {
        Write-Warning "'## 未リリース' 節が残っています。'## $tag' に畳み込んでから再実行してください。"
        exit 1
    }

    if (Invoke-Git -GitArgs @('rev-parse', '-q', '--verify', "refs/tags/$tag") 2>$null) {
        Write-Warning "タグ $tag は既に存在します。確定済みの可能性があります (git tag -d $tag で削除できます)。"
        exit 1
    }

    Write-Step "リリース $tag を確定します (レビュー済み)。"

    # インストーラーは HISTORY.md を同梱するので、レビュー後のこの時点でビルドする。
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
            Write-Warning "ビルドに失敗しました (exit $buildExit)。commit / tag は行いません。"
            exit 1
        }
    }

    Invoke-Git -GitArgs @('add', '--', 'Cargo.toml', 'Cargo.lock', 'installer/md-previewer.iss', 'HISTORY.md')
    Invoke-Git -GitArgs @('commit', '-m', "リリース $tag")
    Invoke-Git -GitArgs @('tag', $tag)

    $artifact = Join-Path $RepoRoot "dist\MdPreviewer-Setup-$version.exe"
    Write-Host ''
    Write-Host "リリース $tag を作成しました。" -ForegroundColor Green
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
        Invoke-Git -GitArgs @('push', 'origin', $tag)
    } else {
        Write-Host ''
        Write-Host "公開するには次を実行してください:" -ForegroundColor Yellow
        Write-Host "    git push origin main; git push origin $tag" -ForegroundColor Yellow
        Write-Skip "念のための最終検査: pwsh -NoProfile -File tools/release-on-main.ps1 -Verify"
    }
    exit 0
}

# ------------------------------------------------------------------
# モード分岐
# ------------------------------------------------------------------
if ($Verify)   { Invoke-Verify }
if ($Finalize) { Invoke-Finalize }

# ==================================================================
# 第 1 段階: バージョン更新 + HISTORY.md 下書き生成
# ==================================================================

# ------------------------------------------------------------------
# 1. ガード: 未確定の下書き / main ブランチ上か / 作業ツリーがクリーンか
# ------------------------------------------------------------------
# 下書きが未確定のまま第 1 段階をもう一度走らせるとバージョンを二重にバンプして
# しまう。-Force は「ツリーが dirty なのは承知」という意味であって「二重バンプして
# よい」ではないので、この検査は -Force でも無効化しない。
if (Test-ReviewPending) {
    Write-Warning @"
未確定のリリース下書きが残っています (HISTORY.md にレビューマーカーあり)。
バージョンの二重バンプを避けるため、第 1 段階を中止しました。

  下書きを仕上げて確定する:
      HISTORY.md を利用者向けに書き換え、'$ReviewToken' コメントを削除してから
      pwsh -NoProfile -File tools/release-on-main.ps1 -Finalize

  下書きを破棄する:
      git checkout -- Cargo.toml installer/md-previewer.iss HISTORY.md
"@
    exit 1
}

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
    $cargoVer = Get-CargoVersion
    if ($cargoVer -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
        Write-Warning "Cargo.toml のバージョン '$cargoVer' を解釈できません。中止します。"
        exit 1
    }
    $baseMajor = [int]$Matches[1]; $baseMinor = [int]$Matches[2]; $basePatch = [int]$Matches[3]
    Write-Skip "リリースタグが見つからないため Cargo.toml ($cargoVer) を基準にします。"
}

# ------------------------------------------------------------------
# 3. コミット範囲の取得 (マージコミット除外) と分類
# ------------------------------------------------------------------
$subjects = @(Invoke-Git -GitArgs @('log', '--no-merges', '--format=%s', $range) | Where-Object { $_ -and $_.Trim() })
if ($subjects.Count -eq 0) {
    Write-Skip "前回リリース ($lastTag) 以降に新しいコミットがありません。何もしません。"
    exit 0
}

$split    = Split-Subjects $subjects
$userSubs = @($split.User)
$intSubs  = @($split.Internal)

# ------------------------------------------------------------------
# 4. バンプ判定
# ------------------------------------------------------------------
# 内部作業 (refactor:/test:/docs: 等) は minor バンプの根拠にしない。
# 以前は全件に対して '追加|機能|対応|実装|新規|feat' を当てていたため、
# リファクタだけのリリースでも minor に上がってしまっていた。
$breakingRe = '破壊的|BREAKING|!:'
$featureRe  = '追加|機能|対応|実装|新規|^feat'

if (-not $Bump) {
    if ($subjects -match $breakingRe)      { $Bump = 'major' }
    elseif ($userSubs -match $featureRe)   { $Bump = 'minor' }
    else                                   { $Bump = 'patch' }
}

switch ($Bump) {
    'major' { $newMajor = $baseMajor + 1; $newMinor = 0;              $newPatch = 0 }
    'minor' { $newMajor = $baseMajor;     $newMinor = $baseMinor + 1; $newPatch = 0 }
    'patch' { $newMajor = $baseMajor;     $newMinor = $baseMinor;     $newPatch = $basePatch + 1 }
}
$newVersion = "$newMajor.$newMinor.$newPatch"
$newTag     = "v$newVersion"

Write-Step "前回タグ: $(if ($lastTag) { $lastTag } else { '(なし)' })  /  バンプ: $Bump  ->  新バージョン: $newVersion"
Write-Host ("対象コミット {0} 件 (利用者向け {1} / 内部 {2}):" -f $subjects.Count, $userSubs.Count, $intSubs.Count) -ForegroundColor DarkGray
$userSubs | ForEach-Object { Write-Host "    [利用者] $_" -ForegroundColor DarkGray }
$intSubs  | ForEach-Object { Write-Host "    [内部]   $_" -ForegroundColor DarkGray }

# ------------------------------------------------------------------
# 5. HISTORY.md 下書きの組み立て
# ------------------------------------------------------------------
# HTML コメント内に '-->' が入ると閉じてしまうので無害化する。
function Escape-ForComment($s) { $s -replace '-->', '--&gt;' }

# 手書きの '## 未リリース' 節があれば、その箇条書きを今回のリリース節に畳み込む。
# (スクリプトの挿入位置は最初の '## v' なので、放置すると未リリース節が
#  リリース節の上に取り残されて内容が重複する)
$histText  = Get-FileText $HistoryMd
$nl        = if ($histText -match "`r`n") { "`r`n" } else { "`n" }
$carried   = @()
$unrelM    = [regex]::Match($histText, '(?m)^##\s*(?:未リリース|Unreleased)\s*$')
if ($unrelM.Success) {
    # 次の '## ' 見出しまでが未リリース節の本文。
    $afterIdx = $unrelM.Index + $unrelM.Length
    $nextM    = [regex]::Match($histText.Substring($afterIdx), '(?m)^##\s')
    $bodyLen  = if ($nextM.Success) { $nextM.Index } else { $histText.Length - $afterIdx }
    $body     = $histText.Substring($afterIdx, $bodyLen)
    $carried  = @($body -split "`r?`n" | Where-Object { $_.TrimStart().StartsWith('-') })
    # 節ごと (見出し + 本文) を取り除く
    $histText = $histText.Substring(0, $unrelM.Index) + $histText.Substring($afterIdx + $bodyLen)
    Write-Skip ("'## 未リリース' 節を検出しました。箇条書き {0} 件を $newTag に畳み込みます。" -f $carried.Count)
}

$reviewBlock = @()
$reviewBlock += "<!-- $ReviewToken : 下の箇条書きを利用者向けに書き換え、このコメントを削除してから"
$reviewBlock += "     pwsh -NoProfile -File tools/release-on-main.ps1 -Finalize"
$reviewBlock += "     を実行してください。マーカーが残っている間は確定できません。"
$reviewBlock += "     HISTORY.md はインストーラーに同梱され、インストール直後に自動表示されます。"
$reviewBlock += ""
$reviewBlock += "     体裁は既存セクションに合わせる:  - **機能名** — 何がどう変わったか。"
$reviewBlock += "     利用者が観測できない変更は載せない。1 つの機能に対する複数コミットは 1 行にまとめる。"
if ($intSubs.Count -gt 0) {
    $reviewBlock += ""
    $reviewBlock += "     内部作業 $($intSubs.Count) 件 (通常は載せない。必要なら「> 開発者向け:」1 行に集約):"
    $intSubs | ForEach-Object { $reviewBlock += "       - $(Escape-ForComment $_)" }
}
$reviewBlock += "-->"

# 箇条書き: 手書きの未リリース分を先に、その後ろに自動抽出の利用者向け候補。
# prefix (feat:/fix: 等) は落とす — 書き換え前でも読める形にしておく。
$bullets = @()
$bullets += $carried
foreach ($s in $userSubs) { $bullets += "- $(Remove-CommitPrefix $s)" }
if ($bullets.Count -eq 0) {
    $bullets = @("- 内部改善（動作の変更はありません）。")
}

if ($DryRun) {
    Write-Host ''
    Write-Step "[DryRun] 以下を更新予定 (実際には変更しません):"
    Write-Host "  Cargo.toml version   -> $newVersion"
    Write-Host "  installer AppVersion -> $newVersion"
    Write-Host "  HISTORY.md 先頭に追記:"
    Write-Host "    ## $newTag"
    $reviewBlock | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    $bullets     | ForEach-Object { Write-Host "    $_" }
    Write-Host ''
    Write-Step "[DryRun] ビルド・コミット・タグは第 2 段階 (-Finalize) で行います。"
    exit 0
}

# ------------------------------------------------------------------
# 6. 3 箇所の書き換え (ビルド・コミット・タグはしない)
# ------------------------------------------------------------------
Write-Step "バージョンを $newVersion に更新し、HISTORY.md に下書きを追記します。"

# パターンの有無を先に確かめる。単に $new -eq $old で判定すると「行が無い」と
# 「既に目標バージョン」を区別できず、誤ったエラーになる。
$cargoText = Get-FileText $CargoToml
$cargoRe   = '(?m)^(\s*version\s*=\s*")[^"]+(")'
if (-not [regex]::IsMatch($cargoText, $cargoRe)) { throw "Cargo.toml の version 行が見つかりませんでした。" }
Set-FileText $CargoToml ([regex]::Replace($cargoText, $cargoRe, "`${1}$newVersion`${2}", 1))

$issText = Get-FileText $IssScript
$issRe   = '(#define\s+AppVersion\s+")[^"]+(")'
if (-not [regex]::IsMatch($issText, $issRe)) { throw "installer/md-previewer.iss の AppVersion が見つかりません。" }
Set-FileText $IssScript ([regex]::Replace($issText, $issRe, "`${1}$newVersion`${2}", 1))

# HISTORY.md: 導入文の直後 (最初の '## v' の手前) に新セクションを挿入。
$section = (@("## $newTag", "") + $reviewBlock + @("") + $bullets + @("", "")) -join $nl
$m       = [regex]::Match($histText, '(?m)^##\s+v')
if ($m.Success) {
    $histNew = $histText.Substring(0, $m.Index) + $section + $histText.Substring($m.Index)
} else {
    $sep = if ($histText.EndsWith($nl)) { '' } else { $nl }
    $histNew = $histText + $sep + $section
}
Set-FileText $HistoryMd $histNew

# ------------------------------------------------------------------
# 7. 次の手順を案内 (ここでは commit / tag / build はしない)
# ------------------------------------------------------------------
Write-Host ''
Write-Host "リリース $newTag の下書きを作成しました (未確定)。" -ForegroundColor Green
Write-Host ''
Write-Host "次の手順:" -ForegroundColor Yellow
Write-Host "  1. HISTORY.md の '## $newTag' 節を利用者向けに書き換え、" -ForegroundColor Yellow
Write-Host "     $ReviewToken コメントを削除する" -ForegroundColor Yellow
Write-Host "  2. pwsh -NoProfile -File tools/release-on-main.ps1 -Finalize" -ForegroundColor Yellow
Write-Host "     (レビュー済みを確認してビルド + commit + tag を行います)" -ForegroundColor Yellow
Write-Skip "インストーラーは HISTORY.md を同梱するため、ビルドは確定時まで行いません。"
exit 0
