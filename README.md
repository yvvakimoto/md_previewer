# md-previewer

Windows 専用の、軽量なスタンドアロン Markdown プレビューアです。  
インターネット接続不要で動作する **閲覧主眼** のビューアで、GitHub Flavored Markdown に加え、図・数式・スライドなど多彩な拡張記法に対応しています。補助機能として、`E` キーで開く内蔵エディタ（CodeMirror 6 + Vim 対応）も同梱しています。

普段使いのテキストエディタで編集 → 保存で自動再読み込み、あるいは内蔵エディタで編集と保存、どちらのワークフローでもお使いいただけます。

---

## 他の Markdown ビューアとの違い

本ツールの設計上のモチベーションは、次の 2 点です。

1. **エンジニアではないユーザー** でも、`.md` ファイルをダブルクリックするだけで見やすく表示できること
2. **表示方法（CSS）の差し替え・追加が簡単** で、組織やプロジェクトの体裁を 1 枚の CSS で配布できること

代表的な既存ツール（VS Code の Markdown Preview / Obsidian / Typora）と並べた比較を以下に示します。

| 観点 | md-previewer（本ツール） | VS Code Markdown Preview | Obsidian | Typora |
| --- | --- | --- | --- | --- |
| 想定ユーザー | 非エンジニア含む閲覧者全般 | エンジニア | ノート編集者（個人 KMS 用途） | ライター／ドキュメント作成者 |
| 起動方法 | `.md` をダブルクリック／フォルダ右クリック | VS Code を起動 →ファイルを開く →プレビューを開く | アプリ起動 → vault を開く | アプリ起動 → ファイルを開く |
| 編集 vs. 閲覧 | **閲覧主眼**（補助的に内蔵エディタ `E` キー、Vim 対応） | エディタ主体（プレビューは副次） | エディタ主体 | WYSIWYG エディタ主体 |
| インストール要件 | 管理者権限不要・WebView2 のみ（Windows 標準） | VS Code 本体（数百 MB） | アプリ本体（Electron） | アプリ本体（Electron） |
| オフライン動作 | ◯（CDN 不使用、全アセット同梱） | ◯ | ◯ | ◯ |
| **CSS テーマの追加方法** | **`assets/` に `.css` を 1 枚置くだけ**（`S` キーのモーダルで選択） | `settings.json` の `markdown.styles` に絶対パス／URL を列挙 | コミュニティテーマのインストール／`.obsidian/snippets/` に CSS 配置 | テーマフォルダに `.css` 配置（命名規約あり） |
| ライセンス | OSS（無償） | OSS（無償） | 個人利用無償／商用有償 | **有償**（v1.0 以降ライセンス購入が必要） |
| 拡張記法 | Mermaid / KaTeX / Marp スライド / Zukai（図解） / CSV・TSV テーブル / **外部CSV→Plotly 対話的チャート** / **Sakuzu（作図）初等幾何作図** / Footnote ツールチップ（標準同梱） | 多くは拡張機能の追加導入が必要 | コアおよびプラグインで対応 | Mermaid / KaTeX 等を内蔵（Marp 非対応） |
| 単独 HTML エクスポート | ◯（`X` キー、KaTeX・Mermaid 等をインライン化した自己完結 HTML） | △（拡張機能依存） | △（プラグイン依存） | ◯ |

### 補足

- **VS Code との違い**: VS Code はエンジニア向け統合開発環境であり、Markdown プレビューはあくまでサイドパネル機能です。CSS のカスタマイズは `settings.json` の `markdown.styles` 配列に絶対パスや URL を列挙する必要があり、非エンジニアには敷居が高めです。本ツールは exe をダブルクリックして開き、`assets/` フォルダに `.css` を置くだけでテーマ候補に加わります（詳細は後述の「テーマのカスタマイズ」を参照）。
- **Obsidian との違い**: Obsidian は vault（フォルダ）を前提とした強力なノート編集アプリで、「もらった単一の `.md` をとりあえず見たい」という用途には機能過剰になりがちです。本ツールは単一ファイル / フォルダどちらにも対応しつつ、編集は外部エディタ または `E` キーの内蔵エディタ（保存検知で自動再読み込み）に委ね、閲覧体験に焦点を絞っています。
- **Typora との違い**: Typora は WYSIWYG 編集を主目的とした有償ツールです。本ツールは OSS で無償、編集 UI を表に出さない代わりに、Marp スライド・Zukai（図解）・CSV テーブル・Footnote ツールチップ・自己完結 HTML エクスポートなど、**閲覧と配布のシナリオ** に最適化された機能を備えています（詳細は後述の「対応している記法・機能」を参照）。

### 本ツールが特に向くケース

- 他人から受け取った `.md` を、追加セットアップなしで一発で開いて見たい
- 自社・チームのロゴや配色を反映したテーマを **1 枚の CSS** として配布したい
- 社内クローズド／オフライン環境で安心して動かしたい
- レビュー結果を **単独 HTML ファイル** として共有・配布したい

---

## 動作環境

- **Windows 10 / 11（64-bit）**
- **Microsoft Edge WebView2 ランタイム**
  - Windows 11 には標準搭載されています
  - Windows 10 でも、最近の Edge をお使いであれば既にインストールされています
  - 入っていない場合は [WebView2 ランタイム公式ページ](https://developer.microsoft.com/microsoft-edge/webview2/) からインストールしてください

macOS / Linux には対応していません。

---

## 配布物の中身

インストール先（`%LOCALAPPDATA%\Programs\MdPreviewer\`）には、以下のファイル／フォルダが展開されます。

| 名前 | 内容 |
| --- | --- |
| `md-previewer.exe` | 実行ファイル本体。スタートメニューから起動するか、`.md` ファイルをダブルクリックして使います。 |
| `assets/` | UI テンプレート、テーマ CSS、Marp テーマ、各種ライブラリ。**必ず `md-previewer.exe` と同じフォルダに置いてください。** |
| `samples/` | 機能デモ用の Markdown 例。スタートメニューの **"Sample Documents"** からも開けます。動作確認や記法のリファレンスとしてご利用ください。任意なので削除しても本体動作には影響しません。 |
| `md-previewer.log` | 起動するたびに上書きされる診断ログ（不具合報告時に参照）。 |

> ⚠ `assets/` フォルダは **exe と同じ場所から動かさない／中の構造を変えない** でください。テーマ切替・図表描画・数式・Marp スライドなど多くの機能が `assets/` 配下のファイルを参照します。

---

## インストールと起動

配布されている `MdPreviewer-Setup-<version>.exe` をダブルクリックしてください。

- インストール先は **`%LOCALAPPDATA%\Programs\MdPreviewer\`**（管理者権限不要、ユーザー単位）
- インストール時のチェックボックスで、次を一括で設定できます（既定オン、任意でオフ可）:
  - `.md` / `.markdown` 拡張子を MD Previewer に関連付け（ダブルクリックで起動）
  - フォルダの右クリックメニューに **"Open with MD Previewer"** を追加
  - `.md` ファイルの右クリックメニューに **"Open with MD Previewer"** を追加
- アンインストールは **Windows「設定 → アプリ」** から行えます（同インストーラが書き込んだ設定も自動で削除されます）

起動後のウィンドウへ `.md` ファイルやフォルダをドラッグ＆ドロップすると、その内容が表示されます。コマンドラインから直接渡すこともできます。

```bat
md-previewer.exe path\to\file.md
md-previewer.exe path\to\folder
```

> Windows「設定 → 既定のアプリ」で `.md` の既定として別アプリを明示的に選んでいる場合、その選択がインストーラの関連付けより優先されます。その際は「設定」から既定を切り替えるか、右クリックメニューの **"Open with MD Previewer"** をお使いください。

---

## ワークスペース（フォルダ）モード

フォルダパスを渡すと、その中のすべての `.md` を一覧表示する **ワークスペースモード** に切り替わります。

```bat
md-previewer.exe path\to\folder
```

- フォルダをウィンドウへドラッグ＆ドロップしても起動できます。
- サイドバーに **ファイルツリー** が現れ、フォルダ単位で折りたたみ可能です。クリックすると当該ファイルが読み込まれます。
- ファイル順は次の優先順で決まります：
  1. `_toc.md`（フォルダ直下）— ネストした箇条書きで明示的に指定
  2. `_toc.md` が無ければ ABC 順（ディレクトリ → ファイルの順、ドットファイルや `node_modules` 等は除外）
- `_toc.md` に書かれていない `.md` は末尾の **Other** グループに自動で並びます。

### `_toc.md` の書式

```markdown
- [はじめに](intro.md)
- 章
    - [入門](chapters/01-getting-started.md)
    - [応用](chapters/02-advanced.md)
- [おわりに](conclusion.md)
```

リンクは Markdown 標準の `[タイトル](相対パス.md)`。ネストしたリストは折りたたみ可能なグループになります。

### ワークスペースの HTML エクスポート

ワークスペースモードで `X` キーを押すと、出力先フォルダ選択ダイアログが開きます。  
中身のすべての `.md` を `.html` に変換し、元のディレクトリ構成を保ったまま書き出します。各ページにはファイルツリーが付くので、静的サイトとしてそのままホスティングできます。

> `X` キーは単一ファイル表示時には単独 HTML ファイル出力、ワークスペースモード時にはフォルダ一括出力、と挙動が自動で切り替わります。

---

## 推奨ワークフロー

- 閲覧は **md-previewer**（`.md` をダブルクリック、またはスタートメニューから起動）
- 編集は次のいずれかから選べます:
  - **外部のテキストエディタ**（VS Code / メモ帳 / サクラエディタなど）— 保存すると **自動で再読み込み** されるので、エディタとプレビューを並べて作業できます
  - **内蔵エディタ**（`E` キーで別ウィンドウ起動、Vim 対応）— 1 つの実行ファイルだけで完結したい場合に

---

## 対応している記法・機能

- **GitHub Flavored Markdown** — 表、タスクリスト、打ち消し線、自動リンクなど
- **シンタックスハイライト** — `highlight.js` による多言語対応、コードブロック右上にコピーボタン
- **Mermaid 図** — フローチャート、シーケンス図、ガントチャート ほか
- **Zukai（図解）図** — fishbone（特性要因図）、mandala chart、BMC（Business Model Canvas）、flow、cycle。コードブロック言語は ` ```zukai `。`title:` と同じ位置で `scale: <倍率>` を指定すると、図全体を縮小/拡大表示できます（例: `scale: 0.7` で 70%、`scale: 1.5` で 150%）
- **KaTeX 数式** — インライン `$...$`、ブロック `$$...$$`
- **脚注** — `[^id]` 参照と `[^id]: 本文` 定義。本文末尾に脚注一覧、参照部はマウスオーバーで Wikipedia 風ポップアップ表示
- **CSV / TSV コードブロック** — ` ```csv ` / ` ```tsv ` で囲むと表として描画
- **Plotly 対話的チャート（外部CSV/TSVから）** — ` ```plotly ` フェンスブロックに `file: data.csv` と `type:` / `x:` / `y:` を YAML で書くだけで、Plotly.js による折れ線・散布・棒・ヒストグラム・箱ひげ・ヒートマップ・3Dサーフェスを描画。CSV ファイルを更新すると自動でグラフが追従。 [Plotly のサンプル](samples/plotly.md) 参照
- **Sakuzu（作図）初等幾何作図** — ` ```sakuzu ` フェンスに式志向 DSL（`A = point(0,0)` / `triangle(A,B,C)` / `circle3(P,Q,R)` / `midpoint` / `foot` / `orthocenter` / `intersection` / `point_on(circle, deg)` / `rotate` / `reflect` ほか）を書くと SVG として展開。Eukleides に着想を得た独自実装（GPL コードは流用していません）。九点円・パスカルの定理など補助線つきの構図を 1 ブロックで描けます。フェンス名は無関係な npm パッケージ `euclid.js` との衝突回避のため、初等幾何の「作図」に由来する日本語名 *Sakuzu* を採用しています。[Sakuzu のサンプル](samples/sakuzu.md) 参照
- **画像**
  - 相対パスは Markdown ファイルのあるフォルダを基準に解決
  - すべて Base64 化してインライン表示（再読み込み時にチラつかない）
  - **Obsidian 風サイズ指定**: `![alt|300](p)`（幅 300px）、`![alt|300x200](p)`（幅×高さ）、`![alt|x200](p)`（高さのみ）、`![alt|@0.5](p)`（元サイズの 0.5 倍）
- **目次（TOC）サイドバー** — 見出しから自動生成、現在位置をハイライト、クリックでスムーズスクロール
- **自動セクション番号** — `N` キーで `1.` `1.1` `1.1.1` …の章番号を ON/OFF
- **クロスファイル `.md` リンク** — `.md` 同士のリンクをクリックすると同じウィンドウで遷移
- **戻る / 進む履歴** — `Alt+←` / `Alt+→`、マウス側面ボタン、右クリックメニューに対応
- **HTML エクスポート** — `X` キーで単一 HTML ファイルに保存（後述）
- **専用エディタウィンドウ** — `E` キーで CodeMirror 6 ベースのエディタを別ウィンドウで起動（後述）
- **Marp プレゼンテーションスライド** — front-matter に `marp: true` を書くと 16:9 のスライドモードに切替

---

## キーボードショートカット

### 共通

| キー | 動作 |
| --- | --- |
| `H` | ヘルプ（ショートカット一覧）の表示 / 非表示 |
| `M` | ダーク / ライトモードの切替（ユーザー CSS とは独立） |
| `S` | スタイル選択モーダル（`assets/` に置いた `.css` を一覧表示・クリックで適用） |
| `N` | セクション自動番号 ON / OFF |
| `E` | エディタウィンドウを開く（Vim 対応・章畳み・数式入力支援・文字数カウント） |
| `X` | 単一 HTML ファイルへエクスポート（保存ダイアログが開きます） |
| `Ctrl` + `+` | ズームイン |
| `Ctrl` + `-` | ズームアウト |
| `Ctrl` + `0` | ズームリセット |
| `Alt` + `←` / `→` | クロスファイル履歴の戻る / 進む |
| `Esc` | モーダル（ヘルプなど）を閉じる |

### Marp スライドモード

| キー | 動作 |
| --- | --- |
| `P` | 表示モードを循環: **scroll**（縦並び）→ **deck**（1 枚ずつ）→ **list**（一覧サムネイル） |
| `←` / `→` / `PgUp` / `PgDn` / `Space` | 前 / 次のスライド（deck モード時） |
| `Home` / `End` | 最初 / 最後のスライドへ（deck モード時） |
| `F` | フルスクリーン切替（deck モード時） |

list モードのサムネイルをクリックすると、そのスライドの deck モードに飛びます。

---

## テーマのカスタマイズ

### 通常プレビュー

`assets/` フォルダに `.css` ファイルを置くと、`M` キーの切替候補に自動で加わります。  
標準で `parchment.css`（羊皮紙風の暖かいクリーム色テーマ）が同梱されています。

選択中のテーマは次回起動時にも復元されます。

### Marp スライドのテーマ

`assets/marp/` フォルダに、先頭に `/* @theme テーマ名 */` を書いた CSS を置くと使えるようになります。  
Markdown 側の front-matter で指定します。

```yaml
---
marp: true
theme: magenta    # ← assets/marp/magenta.css のテーマ名
---
```

同梱: `magenta.css`（マゼンタ + ティールの非ブランドテーマ）。  
Marp 標準の `default` / `gaia` / `uncover` も追加設定なしで利用可能です。

---

## エディタウィンドウ（`E` キー）

`E` キーを押すと、現在プレビューしている Markdown ファイルを編集するための **別ウィンドウ** が開きます。CodeMirror 6 + Vim キーバインドのミニマム UI で、論文の下書き・エッセイ・小説の執筆を想定しています。

### 主な機能

- **Vim モード（任意）** — `@replit/codemirror-vim` による Vim キーバインド。デフォルトは OFF。`:w` / `:wq` / `:q` も使えます。
- **保存（`Ctrl+S`）** — ディスクへ書き込み、プレビューに即時反映（チラつきなし）。
- **ライブプレビュー** — タイプ中も未保存内容がプレビューへ即時反映（保存はせず、タイトルバーの dirty ドットも変化しません）。
- **オートコンプリート**
  - **KaTeX コマンド補完** — 数式コンテキスト（`$…$` / `$$…$$` / `\begin{}…\end{}` の内側）で `\` を打つと、約 200 個の KaTeX コマンド候補がカテゴリ別（greek / operator / relation / arrow / big-op / function / decoration / font / delim / spacing / env / symbol）で並びます。選択時はコマンド種別に応じてテンプレートが挿入され、カーソルが適切な位置に配置されます: `\alpha` などの記号は素挿入、`\sqrt{}` / `\hat{}` などは引数ブレース内、`\frac{}{}` / `\binom{}{}` は第 1 引数ブレース内、`\sum` / `\int` / `\lim` は `_{}^{}` の下付きブレース内、`\begin` / `\end` は環境名補完へ繋ぎます。コードフェンスや通常文中では発火しません。
  - **KaTeX 環境名補完** — `\begin{` の直後に環境名候補（`align`/`matrix`/`cases` ほか）。確定するとカーソルは本文に置かれ、`\end{name}` が自動付加されます。
  - **パス補完** — Markdown リンク `](…` で同階層のファイル・フォルダ名を補完。フォルダ選択時は `/` が追加されてさらに下へ潜れます。
- **章立て畳み** — 見出し（`#`, `##`, …）の左ガターをクリックで折りたたみ。Vim NORMAL では `za` で現セクションのトグル、`zA` で全見出しの一括トグル（畳んだ状態でもすべてのヘディング行は表示されたまま）。
- **見出しジャンプ** — Vim NORMAL で `]]` / `[[` で次／前の ATX 見出しへカーソル移動。
- **YaTeX 相当の数式入力支援** — `$`+`Tab` → `$|$`、`$$`+`Tab` → 表示数式ブロック、`\begin{env}`+`Tab` → 対応する `\end{env}`、数式内で `\frac`/`\sqrt`/`\sum`/… の補完、インライン数式内で `a.` → `\alpha` のようなギリシャ文字略記。さらに **`\left<区切り>` の自動ペア挿入**: 数式内で `\left` の直後に `(` `[` `\{` `\|` `|` `<` `/` `.` `\langle` `\lfloor` `\lceil` `\lgroup` `\lmoustache` `\backslash` のいずれかを入力すると、Tab を介さず即座に対応する `\right<閉じ>` がカーソル後ろに挿入されます（例: `\left(` → `\left(|\right)`、`\left\langle` → `\left\langle|\right\rangle`、`\left.` → `\left.|\right.`）。カーソルは開きの直後にとどまります。すでに `\right` が続いている場合は二重挿入を抑止し、コードフェンスや本文中では発火しません。
- **文字数カウントモーダル** — Vim NORMAL モードで `C` キーを押すとモーダル表示（総文字数・空白除外・本文のみ（YAML/コード/数式除外）・単語数・行数・段落数、選択範囲があれば内訳）。
- **ステータスバー 3 トグル** — 上端ホバーで現れるバーから **Vim ON/OFF**・**行番号（絶対 / 相対 / OFF）**・**テーマ（Light / Dark）** を切替。設定は `localStorage` に永続化されます。
- **プレビュー連動** — プレビュー側でファイルを切り替えるとエディタも追従。Rust 側で 1:1 ペアリングしているので、複数ペアを開いても混線しません。
- **未保存で閉じた場合** — ダーティ状態のままエディタを閉じる（Vim `:q!` やウィンドウの × ボタン）と、プレビューはディスク上の内容に自動復帰します。
- **オフライン** — すべてバンドル済み、ネット接続不要。

---

## HTML エクスポート（`X` キー）

`X` キーを押すと「名前を付けて保存」ダイアログが開き、現在のプレビュー内容を **単一の `.html` ファイル** として書き出します。エクスポートされた HTML には次がすべてインラインで含まれており、追加ファイルなしでそのまま閲覧・配布できます。

- レンダリング済みの本文 DOM
- 適用中のテーマ CSS
- Mermaid / Zukai は SVG として展開
- KaTeX 数式はレンダリング済み HTML として埋め込み
- 画像は Base64
- 目次サイドバー（折りたたみ・スクロールスパイ・スムーズスクロール）
- 脚注ポップアップ用のスクリプト

社内 wiki への貼り付け、メール添付、静的 Web サーバへのアップロードなどにそのままお使いいただけます。

---

## `samples/` フォルダの見方

機能ごとの動作確認用ファイルです。`md-previewer.exe` で開いてみてください。

| ファイル | デモ内容 |
| --- | --- |
| `sample.md` | 主要機能の総合デモ |
| `math.md` | KaTeX 数式 |
| `zukai.md` | Zukai 図解（fishbone / mandala / BMC / flow / cycle） |
| `syntax.md` | コードブロックのシンタックスハイライト |
| `footnotes.md` | 脚注（参照、定義、ポップアップ） |
| `csv-tsv.md` | CSV / TSV コードブロックの表変換 |
| `plotly.md` | 外部 CSV を読み込んで Plotly でチャート化 |
| `sakuzu.md` | Sakuzu（作図）初等幾何作図（九点円・パスカルの定理 ほか） |
| `links.md` + `links-other.md` | クロスファイル `.md` リンクと履歴ナビ |
| `marp.md` | Marp スライドモード |
| `長文技術ドキュメント.md` | 長文 + TOC + セクション番号 |
| `日本語ファイル.md` | 日本語ファイル名・日本語コンテンツ |

---

## オプション拡張：スタイル別エクスポータ

任意の `.css` テーマには、専用の HTML 出力ロジックを差し込むことができます。命名規約は次のとおりです:

- `assets/<base>.css` に対して、同階層に `assets/<base>_export.js` を置く
- そのモジュールは `export async function exportStyle({ currentMarkdown, currentFilePath, preview })` を持つ

このペアが見つかったスタイルが active のときに `X` キーを押すと、汎用 HTML エクスポートの代わりに `exportStyle` が呼ばれます。マップは起動時に Rust ホストが組み立てて `window.__styleExporters` として注入します。該当ファイルが無い場合は汎用パスにフォールスルーします。

---

## トラブルシューティング

| 症状 | 対処 |
| --- | --- |
| 起動しない／画面が真っ白 | [WebView2 ランタイム](https://developer.microsoft.com/microsoft-edge/webview2/) をインストールしてください。 |
| 図や数式が出ない・テーマが反映されない | `assets/` フォルダが `md-previewer.exe` と **同じ場所** にあるか、フォルダ構造を変えていないか確認してください。 |
| `.md` をダブルクリックしても本アプリで開かない | インストーラを再実行し「`.md` / `.markdown` を MD Previewer に関連付ける」がオンになっているか確認してください。Windows「設定 → 既定のアプリ」で別アプリが選ばれている場合は、そちらを MD Previewer に切り替える必要があります。 |
| 画像が表示されない | Markdown ファイルからの相対パスが正しいか確認してください。絶対パスや UNC パスは推奨しません。 |
| 動作がおかしい・原因不明 | `md-previewer.exe` と同じフォルダに生成される `md-previewer.log` を確認してください（起動ごとに上書きされます）。 |

---

## 既知の制限

- **Windows 専用**（macOS / Linux 非対応）
- **閲覧が主目的**（編集は補助機能。`E` キーで内蔵エディタを開けますが、メイン UI はあくまでプレビュー。外部エディタで編集 → 保存しても自動再読み込みされます）
- **Marp モードでは以下が無効になります**:
  - 目次サイドバー
  - `M` キーによるテーマ切替（Marp 側のテーマが優先）
  - `N` キーによるセクション自動番号
  - エディタとのスクロール同期

---

## ライセンス・サードパーティ表記

本アプリは複数の OSS ライブラリ（marked / highlight.js / KaTeX / Mermaid / Marp Core / CodeMirror など）を同梱しています。各ライブラリの著作権表示・ライセンス全文は **`assets/THIRD_PARTY_LICENSES.txt` の 1 ファイルに集約** されています。

このファイルは `tools/collect-licenses.ps1` により自動生成される成果物のため、**本リポジトリには含まれていません**（git-ignored）。ただし、立場によって扱いが異なります。

- **配布版のインストーラ（`MdPreviewer-Setup-*.exe`）を使うエンドユーザー** — 何もする必要はありません。インストーラには `assets/THIRD_PARTY_LICENSES.txt` が同梱されており、インストール後すぐに利用できます。スタートメニューの **"Third-party Licenses"** ショートカット、またはアプリ起動中 `H` キー → ヘルプダイアログ右下の **Third-party licenses** リンクから閲覧できます。
- **ソースからビルドして実行可能な状態にする開発者** — ライセンスファイル自体はアプリの起動に必須ではありませんが、**配布用インストーラを作成する前には必ず生成が必要** です（`installer/md-previewer.iss` が `assets\*` を recurse で取り込むため、ファイルが無いと `iscc` でビルドしても同梱されません）。`build-installer.ps1` 経由でビルドすれば自動で再生成されます。手動で再生成する場合、および `tools/build-marp/` や `tools/build-editor/` の依存を更新した場合は、次のいずれかを実行してください:

  ```powershell
  pwsh -File tools/collect-licenses.ps1
  # もしくは tools/install-deps.ps1 -Licenses
  ```

---

## ソースからビルドする場合（開発者向け）

### 一括ビルド（推奨）

リポジトリ直下の `build.ps1` を実行すると、依存ライブラリ取得 → アイコン生成 → `cargo build --release` → `assets\` を `target\release\assets\` へ同期、までを一気通貫で行います。冪等なので、2 回目以降は完了済みステップをスキップします。

```powershell
.\build.ps1                 # 新規 clone からのフルビルド（release）
.\build.ps1 -DebugBuild     # debug ビルド（target\debug\ へ出力）
.\build.ps1 -Clean          # cargo clean + assets\libs\ 削除 → フル再生成
.\build.ps1 -ForceDeps      # install-deps.ps1 -Force を強制実行
.\build.ps1 -SkipAssetCopy  # cargo build のみ、assets コピーをスキップ
```

`build.ps1` は `assets\libs\editor\editor.iife.js` などのセンチネルファイルを見て、未取得時のみ `tools\install-deps.ps1` を呼び出します。アイコン（`assets\icon.ico`）も未生成時のみ `tools\make-icon\make_icon.py` を実行します。Inno Setup によるインストーラ生成は **行いません** — 配布用インストーラを作る場合は次の `build-installer.ps1` を使ってください。

### インストーラのビルド

配布用の `MdPreviewer-Setup-<version>.exe` を生成するには、リポジトリ直下の `build-installer.ps1` を使います。`build.ps1` → `tools\collect-licenses.ps1`（`assets\THIRD_PARTY_LICENSES.txt` 再生成）→ `iscc installer\md-previewer.iss` を順に実行します。

```powershell
.\build-installer.ps1                          # フル一括（build + licenses + iscc）
.\build-installer.ps1 -SkipBuild               # ビルド済みを再利用
.\build-installer.ps1 -SkipLicenses            # 既存の THIRD_PARTY_LICENSES.txt を再利用
.\build-installer.ps1 -Iscc 'C:\...\ISCC.exe'  # ISCC の場所を明示
```

`ISCC.exe` は PATH から検索し、見つからなければユーザー単位インストール (`%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe`) → マシン単位インストール (`Program Files (x86)\Inno Setup 6\ISCC.exe`) の順に試します。出力は `dist\MdPreviewer-Setup-<AppVersion>.exe`（AppVersion は `installer\md-previewer.iss` から読み出し）。前提として **Inno Setup 6**（[公式サイト](https://jrsoftware.org/isdl.php)）のインストールが必要です。

### 手動で段階的に実行する場合

GitHub からクローンした直後の `assets/libs/` はほぼ空です（自社製の `zukai.js` のみ）。サードパーティ JS/CSS/フォントと、Marp / エディタ用の esbuild IIFE バンドルはコミットされていないため、最初に一度だけ次のコマンドで取得・ビルドしてください。

```powershell
pwsh -File tools\install-deps.ps1
```

これで `tools/fetch-libs.ps1`（marked / mermaid / KaTeX + フォント / highlight.js を cdnjs・jsdelivr からピン留めバージョンでダウンロード）と、`tools/build-marp/` / `tools/build-editor/` の `npm install && npm run build` が順に走り、`assets/libs/` 配下が完成します。フラグ:

- `-Force` — 静的ライブラリを再ダウンロード（既存ファイルを上書き）
- `-SkipNode` — CDN ダウンロードのみ実行（Node がない環境用）
- `-Licenses` — 仕上げに `tools/collect-licenses.ps1` を呼び `assets/THIRD_PARTY_LICENSES.txt` を再生成

この後の `cargo build --release` 等の手順は [`CLAUDE.md`](CLAUDE.md) の "Build & Run Commands" を参照してください。

---

## License

本ソフトウェアは MIT License のもとで公開されています。詳細は [LICENSE](LICENSE) を参照してください。

なお、同梱している第三者ライブラリのライセンスは `assets/THIRD_PARTY_LICENSES.txt` にまとめられており、起動後に `H` キーから開けるヘルプダイアログ内の **Third-party licenses** リンクからも閲覧できます。
