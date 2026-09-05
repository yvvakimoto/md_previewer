# Companion editor / key dispatch

**Owns:** the keymap layers in `tools/build-editor/`: `keyLayout.js`, `jpWordMotion.js`, `mathInputAssist.js`, `clipboardSync.js`, `numberedListIndent.js`
**Read before:** adding any editor key binding. Precedence is where these collide.
**Related:** editor-core.md, editor-cells.md (the pre-Vim gate)

> Relocated verbatim from `CLAUDE.md`. Invariants that apply everywhere stay in
> `CLAUDE.md`; this file holds the detail for the files listed above.

---

### Vim & default keybindings

The Vim extension (`@replit/codemirror-vim`) is swapped in/out of a CodeMirror `Compartment` by the settings modal's Vim toggle (default **OFF** — pure CodeMirror 6 keybindings). When ON, NORMAL mode begins immediately and the `:w` / `:wq` / `:q` / `]]` / `[[` / `za` / `zA` / `gs*` / `gt*` mappings activate. **`C` is deliberately never bound** — it is Vim's change-to-EOL operator (see the comment next to the char-count modal in `entry.js`).

**Tab / Shift+Tab** インデント／アンインデントは `@codemirror/commands` の `indentWithTab` を `mathInputAssistKeymap()` の直後（`searchKeymap`/`defaultKeymap` より前）に挿入することで実現している。これにより数式コンテキスト（`$`+Tab / `\begin{}`+Tab 等）は引き続き YaTeX 風展開が先勝ちし、未マッチ時のみ通常インデントへフォールスルーする。これが無いと WebView2 が未捕捉 Tab をフォーカス遷移として扱い、ステータスバーのトグル等へフォーカスが飛んでしまう。

**数字付きリスト対応インデント** — `mathInputAssistKeymap()` と `indentWithTab` の間に `numberedListIndentKeymap()`（`tools/build-editor/numberedListIndent.js`）を挟み込み、カーソル上方に `^(\s*)(\d+)\.\s` の数字付きリスト祖先が存在するときは Tab / Shift+Tab のインデント単位をマーカーのテキスト幅（`<digits>.` + 半角スペース、例: `1. ` → 3 / `10. ` → 4）に切り替える。CommonMark / GFM が要求する「子要素はマーカー直後のカラムに揃える」規約に合わせるためで、これが無いとデフォルト `indentUnit = 2` のせいで `1. item1` 配下に `- subitem` を書いても `marked` / `pulldown-cmark` 双方で別段落扱いになりリストがネストしない。空白のみの行頭ではマーカー幅倍数のタブストップにスナップし、行頭が `^\s*(?:[-*+]|\d+\.)\s` でカーソルがマーカー内/直後にある場合は行全体を 1 段下げてサブリスト化する（`Enter` で生成された `2. ` を即 `Tab` でデモートする典型シナリオ）。祖先が見つからない通常段落や、行頭以外の位置の `Tab` は `false` を返して `indentWithTab` にフォールスルーするので従来挙動は維持される。フェンス内 (``` / ~~~) は数字付きマーカー探索の対象外。

**日本語ワード境界対応** — `w` / `b` / `e` / `W` / `B` / `E` / `ge` / `gE` および INSERT モードの `<C-w>`、加えて `dw` / `cw` / `yw` / `daw` / `diw` / `vw` などのオペレータ保留形を、漢字 (CJK) / ひらがな / カタカナ / ASCII 単語 / 記号 の文字クラス境界で停止させる。`tools/build-editor/jpWordMotion.js` が upstream `@replit/codemirror-vim` の `findWord` / `moveToWord` を移植して `Vim.defineMotion('moveByWords', ...)` で丸ごと差し替える形で実装。`W` / `B` / `E` の big word は ASCII 単語と ASCII 記号を 1 クラスに潰しつつ日本語 3 クラスは独立、というハイブリッド。長音符 `ー` (U+30FC) はカタカナ固定（`ラーメン` は 1 単語）。Vim OFF 時の CodeMirror 標準 word motion には影響しない。

**Dvorak → QWERTY キー配列マッピング** — Dvorak 配列エミュレータ（やまぶき等）の使用時に、**コマンドモード（ノーマル / ビジュアル / オペレータ待機）** のキーを押した**物理キーの QWERTY 位置**で解釈する。設定モーダルの「キー配列（Vim コマンド）」、`:set dvorak` / `:set nodvorak`、`:keylayout [qwerty|dvorak]` で切替。pref `editor:keyLayout`、既定 **`qwerty`**（= 変換なし）。`tools/build-editor/keyLayout.js`。

- **機構は Vim 本来の `langmap`** で、`Vim.map` を 26 文字に張る方式ではない。バンドル済みの `@replit/codemirror-vim` が `langmap` を**既に実装しており**（`dist/index.js:1244-1247`）、リポジトリでは未使用だった。適用点が `vimKeyFromEvent` 内、すなわち **DOM イベントをキー名に変換する時点でキーバッファが出来る前**なので、複数キー列 (`gg` / `[[` / `gsi` / `gtc` / `gmc`)、オペレータ待機 (`dw`)、カウント (`3j`)、レジスタが**追加実装なしで全部正しく動く**。
- **`Vim.map` 方式が破綻する 3 つの理由**（「単純化」の誘惑に対する記録）: (1) `matchCommand` は**連結済みのキーバッファ文字列**を突き合わせるので 1 文字マッピングは `"gg"` に一致せず 2 キー列が全滅する; (2) `commandMatches` はオペレータ保留中に context を `'operatorPending'` へ書き換える (`dist/index.js:3619`) ので `'normal'` マッピングは `d` の後のモーションに効かない; (3) 全単射マッピングは再帰展開の温床で、`doKeyToKey` のガードはマッピングオブジェクトの同一性単位でしかない。
- **`f` / `t` / `r` / `m` / `'` の引数文字は変換されない** — upstream の `expectLiteralNext`（`<character>` で終わるコマンドに対して `dist/index.js:1610` で立つ）が抑止する。`f` が探すのは「実際に打った文字」であるべきなので、これが正しい。**`"` の後のレジスタ名は変換される**（`<register>` は `expectLiteralNext` の対象外）— 既知の非対称。
- **`code` は読まない。** やまぶきはキーを再送出するので `KeyboardEvent.code` は Dvorak 側にずれるか（Unicode 送出なら）空になる。`langmap` は `e.key` だけを見るので、どちらの実装のエミュレータでも正しく動く。これは実装選択であって偶然ではない。
- **インサートモード・ex ライン (`:`) ・検索 (`/`) は Dvorak のまま** — Dvorak 使いは文字をタッチタイプするので、QWERTY の指の記憶を持つのは**コマンドだけ**。ex ラインと検索は元から無関係で、内部の 4 箇所 (`dist/index.js:1798, 1828, 1928, 6561`) はクロージャローカルの `vimKeyFromEvent(e)` を第 2 引数なしで呼ぶため `vim &&` ガードに弾かれる。エクスポート経由 `Vim.vimKeyFromEvent(e, vim)` を使うのは**メインの keydown 経路 `dist/index.js:8547` だけ**。
- **インサートモード除外だけは自前のラッパ**が要る。upstream は全モードで `vimKeyFromEvent` を通すため本物の Vim と異なりインサートモードにも langmap がかかる。通常のタイプは壊れない（マッチせず `dist/index.js:1040-1041` で `undefined` を返し `preventDefault` されないので、ブラウザが元の文字を挿入する）が、`handleMacroRecording` が変換後のキーを `'q'` と比較する (`dist/index.js:928`) ため、**マクロ記録中にアポストロフィを打つと記録が止まる**。`installInsertModeBypass()` は `Vim.vimKeyFromEvent` を包み、インサートモードでは**第 2 引数を落とす**ことで langmap ブロック自体をスキップさせる。
- **`remapCtrl` は `false` 固定**（設定にしない）。`dist/index.js:1246` の条件により `<C-x>` 系は変換されず素のキーだけが変換される。この種のエミュレータは Ctrl 併用時に素通しするのが通例なので、これが「今動いている Ctrl ショートカットを壊さない」選択。
- **`:set` は upstream 実装を丸ごと差し替えている**ので `:set langmap=…` は届かない。新オプションは必ず `entry.js` の `set` switch に `case` を足すこと（この switch は `opt=value` 構文も解さない）。
- **セルモードの Command モードにも適用**される（`cells.js` の pre-Vim ゲートが `mapCommandKey(e.key)` を通す）。同じ「コマンドモード」で同じ指の記憶なので。既定 `qwerty` では恒等関数なのでオプトインしていない利用者には完全な no-op。
- **Compartment は使わない** — `langmap` は `Vim` シングルトンのグローバル状態でデコレーションを描画しないため、古くなる状態が無い（`setTablePaste` / `applyFontVars` と同じ理由）。`Vim` は `vimComp` と独立なので、Vim OFF のときに設定しても正しい。
- **Tests** — `cd tools/build-editor && node keyLayout.test.mjs`（純粋層。テーブルが全単射であること、シフト側が非シフト側の像であること、そして中心となるのは **upstream `parseLangmap` のミラー実装への往復** — テーブルは `,` と `;` を両辺に含むのでエスケープを誤ると upstream は**エラーを出さずに違う keymap を作る**）。`python tools/preview-harness/dvorakcheck.py`（実物の Vim が要る半分: `gg` / `[[` / `dd` / `dw` / `3j`、`f` の引数、インサートモード、ex ライン、`:set dvorak` / `:keylayout`、セルモード、既定 qwerty の非回帰）。

**OS-clipboard yank/paste (`unnamedplus`)** — plain `y` / `d` / `c` / `x` mirror their text to the **OS clipboard**, and `p` / `P` paste from it, so copy/paste works across editor windows and with other applications (each editor window is a separate WebView2 with its own in-process register, and the OS clipboard is the shared medium — no editor↔editor channel). Implemented in `tools/build-editor/clipboardSync.js` (`installClipboardSync({Vim, ipcSend})`, called once next to `installJpWordMotion`). Three parts: (1) since the editor runs on the insecure `app://` scheme where `navigator.clipboard` is unavailable (and `execCommand('paste')` is disabled), it **replaces `navigator.clipboard.writeText`/`readText`** with IPC-backed shims — `writeText` posts `editor:clipboard:set:<text>` (raw text, not JSON), `readText` posts `editor:clipboard:get:<id>` and resolves when Rust calls back `window.__clipboardResult(id, text)` (mirrors the `editor:listdir:`→`__listDirResult` round-trip; this also makes the package's own `"+y`/`"+p` reliable). (2) Copy side: it wraps the shared register controller's `pushText` (`Vim.getRegisterController()`) so that on any **default-register** push (`!registerName`) it sends the unnamed register's text to the OS clipboard. (3) Paste side: on **window `focus`** (and once at boot) it pulls the OS clipboard *into* the unnamed register (charwise) so `p`/`P` paste external/cross-editor text via the package's normal synchronous paste path — guarded by `__lastLocalClip` so it never clobbers a locally-yanked **linewise** register (`yy`→`p` stays linewise; external text is inherently charwise, which is correct). The Rust side (`src/clipboard_win.rs`, `clipboard-win` crate) does the Win32 clipboard work; the `editor:clipboard:set:` handler runs on a worker thread so a transiently locked clipboard never blocks the IPC thread (see `src/editor_registry.rs`).

### Math input assist (YaTeX 風)

- `$`+Tab → `$|$`
- `$$`+Tab → fenced display block
- `\begin{env}`+Tab → matching `\end{env}`
- in-math command stubs: `\frac` / `\sqrt` / `\sum` / …
- `a.` / `b.` / `g.` → `\alpha` / `\beta` / `\gamma` greek shortcuts inside inline math
- **`\left<delim>` 自動ペア挿入** — 数式コンテキスト内で `\left` の直後に区切り文字 (`(` `[` `\{` `\|` `|` `<` `/` `.` `\langle` `\lfloor` `\lceil` `\lgroup` `\lmoustache` `\backslash`) を入力すると、即座に対応する `\right<closer>` がカーソル後ろに自動挿入される（例: `\left(` → `\left(|\right)`、`\left\langle` → `\left\langle|\right\rangle`、`\left.` → `\left.|\right.`）。カーソルは開き直後にとどまる。Tab は不要。`mathInputAssist.js` の `leftRightAutoPair()`（`EditorState.transactionFilter`）で実装。コードフェンスや通常文中では発火しない（`isInsideMath` で判定）。発火条件は 3 段構えで、いずれも**実挙動の不具合を受けて**入っている:
  - **「実際に挿入したか」ガード** — `isUserEvent('input.type')` に加えて、そのトランザクションが**カーソル位置で終わる単一の純粋な挿入**であること（`tr.changes.iterChanges` で削除・置換・複数変更を除外）を要求する。「カーソル直前がたまたま `\left(` で終わっている」だけでは発火しない。`@replit/codemirror-vim` は**削除を含む全ての Vim 編集**をアダプタ経由で `userEvent: "input.type.compose"` として dispatch する（`dist/index.js` の `dispatchChange()` / `replaceRange()`）ため、このガードが無いと Vim で自動挿入された `\right)` を `d$` / `7x` / `df)` などで消した瞬間にカーソルが `\left(` 直後に来て再挿入され、**永久に消せなくなる**。Vim の INSERT モードの通常タイプはアダプタを通らず（マッチしないキーは CM6 のネイティブ入力経路へフォールスルー）純粋な `input.type` 挿入になるので、自動ペアは従来どおり働く。IME 変換確定（`input.type.compose` かつ純粋な挿入）も従来どおり発火する。副作用として貼り付け (`input.paste`) と補完確定 (`input.complete`) では発火しなくなった（意図的）。
  - **前方の未対応 `\right` 検出** — カーソル以降を囲っている数式領域の終端（`$$` / 未エスケープ `$` / `\end{` まで、上限 4000 文字）までスキャンし、`\left` と対応の取れていない `\right` が既にあれば挿入しない（`hasUnmatchedRightAhead()`）。既存の `\left(x + y\right)` の開き側を打ち直したときの二重挿入を防ぐ。旧実装はカーソル直後 8 文字しか見ていなかったため、`\right` が離れていると重複した。トークン判定の否定先読み `(?![a-zA-Z])` により `\rightarrow` / `\leftarrow` は数えない。
  - **Backspace でペアごと削除** — カーソルが対応する `\left<open>` と `\right<closer>` のちょうど間にあるとき、Backspace 1 回で両トークンを削除する（`leftRightBackspace()`、`closeBrackets` の `deleteBracketPair` 相当）。それ以外は `false` を返して通常の Backspace にフォールスルーする。`mathInputAssistKeymap()` は `entry.js` で `defaultKeymap` より前に展開されているのでフォールスルーが効き、Vim 有効時も `keys.Backspace` → `runScopeHandlers(..., 'editor')` 経由で到達する。

### Heading nav & section folding

ATX-heading code folding via a custom `foldService` on `#` / `##` / `###…` lines.

In Vim NORMAL:
- `]]` / `[[` — move to the next / previous ATX heading line
- `za` — toggle the fold on the section enclosing the cursor
- `zA` — toggle all heading folds (if any fold is active, all are unfolded; otherwise every ATX section's *body* is folded — each fold stops at the next heading regardless of level, so every heading line stays visible)

Implemented in `tools/build-editor/entry.js` via `Vim.defineAction` + `Vim.mapCommand` (`context: 'normal'`) and `@codemirror/language`'s `foldEffect` / `unfoldEffect` / `foldedRanges` / `unfoldAll`, sharing the `computeHeadingFoldRange` helper with the existing `foldService`.
