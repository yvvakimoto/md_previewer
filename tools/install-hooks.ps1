<#
.SYNOPSIS
    リポジトリ追跡の git フック (tools/hooks) を有効化する。

.DESCRIPTION
    core.hooksPath は .git/config に保存されるローカル設定のため、クローン毎に
    1 回設定が必要。install-deps.ps1 から自動的に呼ばれるほか、手動でも実行できる。
#>
param()

$ErrorActionPreference = 'Stop'

$RepoRoot  = Split-Path -Parent $PSScriptRoot
$HooksPath = 'tools/hooks'   # core.hooksPath は POSIX 区切りで保存する

# git リポジトリでない場合は黙って終了 (CI のソース展開など)
& git -C $RepoRoot rev-parse --is-inside-work-tree *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "git リポジトリではないため、フック設定をスキップしました。" -ForegroundColor DarkGray
    return
}

& git -C $RepoRoot config core.hooksPath $HooksPath
Write-Host "core.hooksPath を '$HooksPath' に設定しました。" -ForegroundColor Green
Write-Host "main へのマージ時に tools/hooks/post-merge が自動リリースを実行します。" -ForegroundColor DarkGray
