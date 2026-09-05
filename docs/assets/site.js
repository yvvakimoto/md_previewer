/* ==========================================================================
   MD Previewer for Windows — landing page behaviour
   Language toggle, theme toggle, scroll reveal, latest-version badge.

   The i18n layer deliberately mirrors the app's own convention (see
   .claude/docs/i18n.md): data-i18n / data-i18n-html /
   data-i18n-attr in the markup, one applyI18n() pass, and a KEY-MAJOR string
   table so a message and its translation sit on adjacent lines and neither can
   be added without seeing the other.
   ========================================================================== */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- strings */
  /* ja is the source text; en is a translation of it, not a separate page.
     Keep both non-empty -- t() falls back to ja, so a missing en silently
     ships Japanese to an English reader. */
  var I18N = {
    'meta.title':    { ja: 'MD Previewer for Windows — .md をダブルクリックするだけ',
                       en: 'MD Previewer for Windows — just double-click the .md' },
    'nav.skip':      { ja: '本文へスキップ', en: 'Skip to content' },
    'nav.uses':      { ja: '使い方', en: 'Use cases' },
    'nav.features':  { ja: 'できること', en: 'Features' },
    'nav.gallery':   { ja: '実例', en: 'Examples' },
    'nav.keys':      { ja: 'キー操作', en: 'Shortcuts' },
    'nav.download':  { ja: 'ダウンロード', en: 'Download' },
    'nav.theme':     { ja: '配色を切り替え', en: 'Toggle colour scheme' },
    'nav.langLabel': { ja: '表示言語', en: 'Display language' },

    'hero.eyebrow': { ja: 'スタンドアロン Markdown プレビューア',
                      en: 'A standalone Markdown previewer' },
    'hero.lead':    { ja: '<code>.md</code> をダブルクリックするだけ。図も数式も Marp スライドも縦書きの文庫レイアウトも、インストールした直後から <b>完全オフライン</b>で表示できます。',
                      en: 'Double-click a <code>.md</code> file. Diagrams, math, Marp slides and vertical Japanese typesetting all render <b>fully offline</b>, straight after install.' },
    'hero.cta1':    { ja: '無料でダウンロード', en: 'Download — it’s free' },
    'hero.cta2':    { ja: 'GitHub で見る', en: 'View on GitHub' },
    'hero.note':    { ja: '<b>Windows 10 / 11 専用です。</b> macOS・Linux には対応していません。',
                      en: '<b>Windows 10 / 11 only.</b> There is no macOS or Linux build.' },
    'hero.tag1':    { ja: '管理者権限なし', en: 'No admin rights' },
    'hero.tag2':    { ja: 'CDN 不使用', en: 'No CDN at runtime' },
    'hero.tag3':    { ja: 'MIT ライセンス', en: 'MIT licensed' },
    'hero.tag4':    { ja: 'WebView2 のみ', en: 'WebView2 only' },
    'hero.shotAlt': { ja: '目次サイドバー付きで Markdown 文書を表示している MD Previewer のウィンドウ',
                      en: 'The MD Previewer window showing a Markdown document beside its table-of-contents sidebar' },

    'step1.t': { ja: 'インストーラを実行', en: 'Run the installer' },
    'step1.d': { ja: '管理者権限は要りません。ユーザー単位で入ります。',
                 en: 'No admin rights needed — it installs per user.' },
    'step2.t': { ja: '<code>.md</code> をダブルクリック', en: 'Double-click a <code>.md</code>' },
    'step2.d': { ja: 'ドラッグ＆ドロップ、フォルダの右クリックでも開けます。',
                 en: 'Dropping a file on the window and right-clicking a folder work too.' },
    'step3.t': { ja: '保存すれば、すぐ映る', en: 'Save, and it updates' },
    'step3.d': { ja: '使い慣れたエディタで保存すると、その場で描き直します。',
                 en: 'Save in whichever editor you already use; the view redraws itself.' },

    'uses.kicker': { ja: 'USE CASES', en: 'USE CASES' },
    'uses.title':  { ja: '5 とおりの、ちょうどいい使い道。', en: 'Five people it was built for.' },
    'uses.lead':   { ja: '機能の数より、どう効くか。よく使われている 5 つの場面を挙げます。',
                     en: 'Not a feature count — five situations where it actually earns its place.' },

    'use1.chip':  { ja: 'だれでも', en: 'for everyone' },
    'use1.title': { ja: '開いて、読むだけ。', en: 'Just open it.' },
    'use1.body':  { ja: '同僚から、あるいは AI から受け取った <code>.md</code> を、何の準備もなく読めます。見出しから目次が自動で組まれ、外部エディタで保存すればその場で再読込。フォルダごと渡されたときは、ファイルツリー付きのワークスペースとして開きます。',
                    en: 'Read the <code>.md</code> a colleague — or an AI — just handed you, with no setup at all. A table of contents builds itself from the headings, the view reloads the moment the file is saved, and a whole folder opens as a workspace with a file tree.' },
    'use1.p1':    { ja: '目次サイドバー', en: 'Table-of-contents sidebar' },
    'use1.p2':    { ja: 'ファイル関連付け', en: 'File association' },
    'use1.p3':    { ja: '保存を検知して再読込', en: 'Reloads on save' },
    'use1.p4':    { ja: '単独 HTML / PDF 書き出し', en: 'Self-contained HTML / PDF' },
    'use1.alt':   { ja: '目次サイドバーと本文を並べて表示している画面',
                    en: 'The document rendered beside its table-of-contents sidebar' },

    'use2.chip':  { ja: 'プレゼンする人へ', en: 'for presenters' },
    'use2.title': { ja: 'Markdown のまま、発表する。', en: 'Present straight from Markdown.' },
    'use2.body':  { ja: '冒頭に <code>marp: true</code> と 1 行書けば、その文書はもう 16:9 のスライドです。<kbd>P</kbd> で「1 枚ずつ / サムネイル一覧 / 縦並び」を切り替え、<kbd>Z</kbd> でレーザーポインタ。下にはみ出した本文は見出しを固定したまま自動で縮み、PDF は 1 ページ 1 スライドで出ます。',
                    en: 'One line of front matter — <code>marp: true</code> — and the document is a 16:9 deck. <kbd>P</kbd> cycles one-at-a-time / thumbnail grid / vertical scroll, <kbd>Z</kbd> arms a laser pointer, a body that overruns shrinks itself while the heading stays put, and the PDF comes out one page per slide.' },
    'use2.p1':    { ja: 'Marp Core を内蔵', en: 'Marp Core bundled' },
    'use2.p2':    { ja: '3 つの表示モード', en: 'Three view modes' },
    'use2.p3':    { ja: 'レーザーポインタ', en: 'Laser pointer' },
    'use2.p4':    { ja: 'スライドの自動縮小', en: 'Shrink-to-fit slides' },
    'use2.p5':    { ja: '2 カラム / 図・数式', en: 'Two columns, figures & math' },
    'use2.alt1':  { ja: 'グラデーションの章扉スライド', en: 'A gradient section-divider slide' },
    'use2.alt2':  { ja: 'Mermaid のフローチャートを載せたスライド', en: 'A slide carrying a Mermaid flowchart' },
    'use2.alt3':  { ja: '2 カラムに数式と Plotly の 3D サーフェスを並べたスライド', en: 'A two-column slide pairing math with a Plotly 3D surface' },

    'use3.chip':  { ja: '研究する人へ', en: 'for researchers' },
    'use3.title': { ja: '数式を、書く速さで。', en: 'Math at the speed of writing.' },
    'use3.body':  { ja: 'KaTeX がインラインもディスプレイも組みます。数式を右クリックすれば <b>MathML</b> と <b>LaTeX</b> をコピーでき、Word にそのまま貼れます。内蔵エディタには YaTeX 風の入力支援 — <code>$</code>+Tab、<code>\\begin{}</code>+Tab、<code>a.</code>→<code>\\alpha</code>。可換図式は tikz-cd をそのまま書けば、WASM 版 TeX がオフラインで組みます。ファインマン図も平面・立体の幾何作図も、同じように書いた分だけ図になります。',
                    en: 'KaTeX sets both inline and display math. Right-click any formula to copy it as <b>MathML</b> or <b>LaTeX</b> and paste it straight into Word. The built-in editor adds YaTeX-style input assist — <code>$</code>+Tab, <code>\\begin{}</code>+Tab, <code>a.</code>→<code>\\alpha</code> — and commutative diagrams are plain tikz-cd, typeset offline by a WebAssembly TeX engine. Feynman diagrams and 2D / 3D geometry constructions come out the same way: you write them, they draw.' },
    'use3.p1':    { ja: 'KaTeX', en: 'KaTeX' },
    'use3.p2':    { ja: 'MathML / LaTeX コピー', en: 'Copy as MathML / LaTeX' },
    'use3.p3':    { ja: '数式入力支援', en: 'Math input assist' },
    'use3.p4':    { ja: 'tikz-cd 可換図式', en: 'tikz-cd diagrams' },
    'use3.p5':    { ja: 'ファインマン図', en: 'Feynman diagrams' },
    'use3.p6':    { ja: '幾何作図 2D / 3D', en: '2D / 3D geometry' },
    'use3.alt1':  { ja: '\\begin{ の入力で環境名の補完候補が出ているエディタ',
                    en: 'The editor offering environment-name completions after \\begin{' },
    'use3.alt2':  { ja: 'tikz-cd で描かれた可換図式', en: 'Commutative diagrams drawn with tikz-cd' },

    'use4.chip':  { ja: '書く人へ', en: 'for writers' },
    'use4.title': { ja: '文庫のかたちで、書く。', en: 'Write it like a paperback.' },
    'use4.body':  { ja: '付属テーマ <code>bunko.css</code> を選ぶと、本文は <b>1 行 39 字 × 16 行</b>の縦組みページに流し込まれ、ページの地にノンブルが入ります。段落は本物の本と同じようにページをまたいで割れる。字数と行数を見ながら書けて、ルビも振れます。字数・行送り・書体は歯車から動かせて、その場で組み直します。',
                    en: 'Pick the bundled <code>bunko.css</code> theme and the text flows into vertical pages of <b>39 characters by 16 lines</b>, each with a folio at its foot. Paragraphs break across pages exactly as they do in a real book. You write while watching the character count, ruby annotations included — and characters per line, leading and typeface are all adjustable from a gear, retypesetting as you drag.' },
    'use4.p1':    { ja: '39 字 × 16 行の行取り', en: '39 × 16 line grid' },
    'use4.p2':    { ja: 'ノンブル', en: 'Page folios' },
    'use4.p3':    { ja: 'ルビ（振り仮名）', en: 'Ruby annotations' },
    'use4.p4':    { ja: 'A4 横に見開き 2 ページの PDF', en: 'Two-up A4 landscape PDF' },
    'use4.alt':   { ja: '縦書き・ノンブル付きの文庫レイアウトで表示された小説',
                    en: 'A short story set vertically in paperback layout, with page folios' },

    'use5.chip':    { ja: 'こだわる人へ', en: 'for the particular' },
    'use5.title':   { ja: '指の記憶に、道具を合わせる。', en: 'Bend the tool to your muscle memory.' },
    'use5.body':    { ja: '内蔵エディタは Vim キーバインドに対応し、<kbd>w</kbd> <kbd>b</kbd> <kbd>e</kbd> は漢字・ひらがな・カタカナの切れ目で止まります。そして Dvorak 配列エミュレータを使っている人のために、<b>コマンドモードのキーだけ</b>を、押した物理キーの QWERTY 位置で解釈できます。文章の入力は Dvorak のまま。',
                      en: 'The built-in editor speaks Vim, and <kbd>w</kbd> <kbd>b</kbd> <kbd>e</kbd> stop at the boundaries between kanji, hiragana and katakana. And if you drive Dvorak through a layout emulator, it can read <b>command-mode keys only</b> at the QWERTY position of the key you physically pressed — while your prose still types in Dvorak.' },
    'use5.mapCap':  { ja: 'Dvorak エミュレータ使用時 · <code>:set dvorak</code>',
                      en: 'With a Dvorak emulator · <code>:set dvorak</code>' },
    'use5.legend1': { ja: '押した物理キー', en: 'Key you press' },
    'use5.legend2': { ja: 'Dvorak が送る文字', en: 'What Dvorak sends' },
    'use5.legend3': { ja: 'Vim が受け取るコマンド', en: 'What Vim receives' },
    'use5.mapNote': { ja: '<code>dd</code> <code>dw</code> <code>gg</code> <code>3j</code> <code>[[</code> のような複数キーや回数指定もそのまま。インサートモードと <code>:</code> <code>/</code> の入力は Dvorak のままです。',
                      en: 'Multi-key sequences and counts — <code>dd</code>, <code>dw</code>, <code>gg</code>, <code>3j</code>, <code>[[</code> — all follow. Insert mode and whatever you type after <code>:</code> or <code>/</code> stay in Dvorak.' },
    'use5.p1':      { ja: 'Vim キーバインド', en: 'Vim keybindings' },
    'use5.p2':      { ja: '日本語のワード境界', en: 'Japanese word motions' },
    'use5.p3':      { ja: 'Jupyter 風セルモード', en: 'Jupyter-style cell mode' },
    'use5.p4':      { ja: 'Dvorak → QWERTY 転送', en: 'Dvorak → QWERTY mapping' },
    'use5.alt':     { ja: 'Vim の ex コマンド :set dvorak を入力している内蔵エディタ',
                      en: 'The built-in editor with the Vim ex command :set dvorak typed in' },

    'feat.kicker':   { ja: 'THE LITTLE THINGS', en: 'THE LITTLE THINGS' },
    'feat.title':    { ja: 'かゆいところに、手が届きます。', en: 'Right down to the little things.' },
    'feat.lead':     { ja: '素の Markdown で足りないときの記法とエンジンを、ひととおり揃えました。追加インストールもネットワークも要りません。',
                       en: 'The notations and engines you reach for when plain Markdown runs out — all here, with nothing to install and no network to reach.' },
    'feat.credit':   { ja: '描画の中身は、上に挙げた各オープンソースプロジェクトの成果です。タイルをクリックすると本家のサイトへ移動します。ライセンス全文はアプリに収録してあり、ヘルプ（<kbd>H</kbd>）→ サードパーティ表記から読めます。作者のみなさんに感謝します。ほかに CSV / TSV 表、脚注、定義リスト、タスクリスト、機密透かしなども使えます。',
                       en: 'The rendering itself is the work of the open-source projects above — each tile links to its upstream, and the full licence texts ship with the app under Help (<kbd>H</kbd>) → Third-party licenses. Thank you to their authors. Also included: CSV / TSV tables, footnotes, definition lists, task lists and confidential watermarks.' },

    'lib.marked':    { ja: 'Markdown 本文の解析', en: 'Parses the Markdown itself' },
    'lib.hljs':      { ja: 'コードの色分け', en: 'Colours the code blocks' },
    'lib.katex':     { ja: 'インライン / ディスプレイ数式', en: 'Inline and display math' },
    'lib.mermaid':   { ja: 'フロー・シーケンス・ガント', en: 'Flow, sequence, Gantt' },
    'lib.marp':      { ja: '16:9 スライドの組版', en: 'Typesets the 16:9 deck' },
    'lib.plotly':    { ja: '外部 CSV から対話グラフ', en: 'Interactive charts from a CSV' },
    'lib.abcjs':     { ja: 'ABC 記譜法を五線譜に', en: 'ABC notation as staff notation' },
    'lib.markwhen':  { ja: '年表・カレンダー', en: 'Timelines and calendars' },
    'lib.tikz':      { ja: 'tikz-cd の可換図式（任意導入）', en: 'tikz-cd diagrams (opt-in)' },
    'lib.kataskeve': { ja: '平面幾何の作図', en: 'Plane-geometry constructions' },
    'lib.kataskeve3d': { ja: '立体の陰線処理とペン画', en: 'Hidden-line solids drawn in ink' },
    'lib.feynmark':  { ja: 'ファインマン図', en: 'Feynman diagrams' },
    'lib.cm':        { ja: '内蔵エディタの土台', en: 'The built-in editor’s base' },
    'lib.cmvim':     { ja: 'Vim キーバインド', en: 'Vim keybindings' },
    'lib.dendenT':   { ja: 'でんでんマークダウン', en: 'Denden Markdown' },
    'lib.denden':    { ja: 'ルビ記法のもとにした仕様', en: 'The spec our ruby syntax follows' },

    'lic.own':       { ja: '本体実装', en: 'Built in' },
    'lic.spec':      { ja: '記法仕様', en: 'Syntax spec' },

    'own.tateT':     { ja: '縦書き・文庫組み', en: 'Vertical & paperback' },
    'own.tate':      { ja: '禁則・縦中横・39 字 × 16 行', en: 'Kinsoku, tate-chu-yoko, a 39 × 16 grid' },
    'own.rubyT':     { ja: 'ルビ', en: 'Ruby' },
    'own.ruby':      { ja: 'グループルビ・モノルビ', en: 'Group and mono ruby' },
    'own.layoutT':   { ja: '配置と多段組み', en: 'Alignment & columns' },
    'own.layout':    { ja: '<code>::: center</code> / <code>::: columns</code>',
                       en: '<code>::: center</code> / <code>::: columns</code>' },
    'own.spanT':     { ja: 'インラインスタイル', en: 'Inline styles' },
    'own.span':      { ja: '文字色・サイズ・書体を部分指定', en: 'Colour, size and typeface per run' },
    'own.tblT':      { ja: '表の往復', en: 'Tables both ways' },
    'own.tbl':       { ja: 'PowerPoint と相互に貼付', en: 'Paste to and from PowerPoint' },
    'own.vidT':      { ja: '動画', en: 'Video' },
    'own.vid':       { ja: 'ローカル動画・YouTube', en: 'Local files and YouTube' },
    'own.exportT':   { ja: '書き出し', en: 'Export' },
    'own.export':    { ja: '単独 HTML・しおり付き PDF', en: 'One-file HTML, bookmarked PDF' },
    'own.themeT':    { ja: 'テーマ', en: 'Themes' },
    'own.theme':     { ja: 'CSS を 1 枚置くだけ', en: 'Drop in a single CSS file' },
    'own.wsT':       { ja: 'ワークスペース', en: 'Workspaces' },
    'own.ws':        { ja: 'フォルダを開いてファイルツリー', en: 'Open a folder, get a file tree' },

    'gal.kicker': { ja: 'SEE IT', en: 'SEE IT' },
    'gal.title':  { ja: '書き方と、出てくるもの。', en: 'The syntax, and what it makes.' },
    'gal.lead':   { ja: 'それぞれ、書く Markdown と、プレビューでの見え方です。どれも追加の設定なしで、そのまま出ます。',
                    en: 'For each one: the Markdown you write, and how the preview renders it. Nothing to configure.' },
    'gal.note':   { ja: '画像はどれも、添えたソースをこのプレビューアで実際に描画したものです。カレンダーの祝日はオンラインのときだけ取得します（取れなければ祝日なしで描きます）。縦書き・文庫組みの例は上の「文庫のかたちで、書く。」を、スライドの例は「Markdown のまま、発表する。」をご覧ください。',
                    en: 'Every picture here is the snippet shown with it, actually rendered by this previewer. Calendar holidays are fetched only when online (without a connection it simply draws none). For vertical paperback typesetting see “Write it like a paperback” above, and for slides see “Present straight from Markdown”.' },

    'gal.rubyT':     { ja: 'ルビ', en: 'Ruby' },
    'gal.rubyTag':   { ja: 'でんでん記法', en: 'Denden syntax' },
    'gal.rubyAlt':   { ja: '吾輩と猫に振り仮名が添えられた一文',
                       en: 'A sentence with ruby readings over two kanji words' },
    'gal.csvT':      { ja: '表', en: 'Table' },
    'gal.csvTag':    { ja: 'CSV フェンス', en: 'A csv fence' },
    'gal.csvAlt':    { ja: 'CSV から組まれた見出し付きの表',
                       en: 'A table with a header row, built from CSV' },
    'gal.colT':      { ja: '多段組み', en: 'Columns' },
    'gal.colTag':    { ja: 'フェンス記法', en: 'A fenced div' },
    'gal.colAlt':    { ja: '1 カラムの文章のあとアエネーイスの原文と訳が 2 カラムで並び、また 1 カラムに戻る例',
                       en: 'A page in one column, then the Aeneid in Latin beside its translation in two, then one column again' },
    'gal.abcT':      { ja: '楽譜', en: 'Staff notation' },
    'gal.abcTag':    { ja: 'ABC 記譜法', en: 'ABC notation' },
    'gal.abcAlt':    { ja: 'きらきら星の旋律が五線譜に描かれたもの',
                       en: 'The tune of Twinkle, Twinkle drawn on a stave' },
    'gal.mwT':       { ja: '年表', en: 'Timeline' },
    'gal.mwAlt':     { ja: '企画と開発の期間が横棒で並んだタイムライン',
                       en: 'A timeline with planning and development drawn as bars' },
    'gal.calT':      { ja: 'カレンダー', en: 'Calendar' },
    'gal.calAlt':    { ja: '4 月の月間カレンダー。予定が色付きの帯で並び、祝日が強調表示されている',
                       en: 'A monthly calendar for April, events drawn as coloured bars and a public holiday highlighted' },
    'gal.mermaidT':  { ja: '図', en: 'Diagram' },
    'gal.mermaidAlt':{ ja: '編集から保存を経てスライドとプレビューへ分岐するフローチャート',
                       en: 'A flowchart branching from edit through save into slides and preview' },
    'gal.plotlyT':   { ja: 'チャート', en: 'Chart' },
    'gal.plotlyTag': { ja: '外部 CSV + Plotly', en: 'An external CSV, via Plotly' },
    'gal.plotlyAlt': { ja: '外部 CSV から描かれた月次売上の折れ線グラフ',
                       en: 'A monthly revenue line chart drawn from an external CSV' },
    'gal.mathT':     { ja: '数式', en: 'Math' },
    'gal.mathAlt':   { ja: '二次方程式の解の公式が組版されたもの',
                       en: 'The quadratic formula, typeset' },
    'gal.tikzT':     { ja: '可換図式', en: 'Commutative diagram' },
    'gal.tikzAlt':   { ja: 'A・B・C・D を矢印で結んだ可換正方形',
                       en: 'A commutative square joining A, B, C and D with labelled arrows' },
    'gal.ksT':       { ja: '作図', en: 'Geometry' },
    'gal.ksAlt':     { ja: '直角記号と角の弧が添えられた直角三角形の作図',
                       en: 'A right triangle drawn with a right-angle marker and an angle arc' },
    'gal.ks3T':      { ja: '立体', en: 'Solids' },
    'gal.ks3Alt':    { ja: '点描で陰影をつけたペンローズの三角形',
                       en: 'A Penrose triangle shaded with stipple' },
    'gal.feyT':      { ja: 'ファインマン図', en: 'Feynman diagram' },
    'gal.feyAlt':    { ja: '電子と陽電子が光子を介してミューオン対になるツリーレベルの図',
                       en: 'A tree-level diagram: an electron and a positron annihilating into a muon pair through a photon' },

    /* Shortcuts section. The 21 preview rows mirror the app's OWN help-modal
       strings (__I18N 'help.key.*' in assets/index.html) and 19 of them are
       byte-for-byte copies -- the translations were already written there and
       are already good. Two exceptions are reworded because the app's wording
       names the modal it lives in, which is meaningless on a web page; both are
       declared in docskeycheck.py's ADAPTED set:
         keys.h    'このヘルプの表示 / 非表示'  -> 'アプリ内のショートカット一覧の…'
         keys.esc  'このダイアログを閉じる'      -> '開いているモーダルを閉じる…'
       DO NOT re-space the copied strings. The app writes 「Marpモード」/「Marp表示」
       with no space while this page's own copy writes 「Marp スライド」; the checker
       compares descriptions literally after collapsing whitespace, and a space
       between CJK and Latin does not collapse -- so a cosmetic re-space is 19
       permanent warnings. Section furniture uses the page's voice; the reused
       rows keep the app's.
       The row suffixes deliberately match the app's ('keys.h' <-> 'help.key.h')
       so the two tables can be paired mechanically rather than by text.
       Any value carrying markup must carry it in BOTH languages: promoteHtmlKeys()
       promotes on either one, after which applyI18n writes innerHTML for both. */
    'keys.kicker': { ja: 'ONE KEY EACH', en: 'ONE KEY EACH' },
    'keys.title':  { ja: 'メニューは、ありません。', en: 'No menus — just keys.' },
    'keys.lead':   { ja: '表示の切り替えも書き出しも、キー 1 つです。',
                     en: 'Switching the view and exporting are each a single key.' },

    'keys.g1': { ja: 'ウィンドウの表示', en: 'The window' },
    'keys.g2': { ja: '開く・書き出す', en: 'Open and export' },
    'keys.g3': { ja: 'Marp スライド', en: 'Marp slides' },
    'keys.g4': { ja: 'エディタウィンドウ', en: 'The editor window' },

    'keys.g3note': { ja: 'Marp 文書のときだけ効きます。下の 4 つはデッキ表示中のみ。',
                     en: 'Only in a Marp document — and the last four only in deck view.' },
    'keys.g4note': { ja: 'プレビューで <kbd>E</kbd> を押すと開きます。Vim キーバインドは <kbd>⚙ 設定</kbd> でオンにします。',
                     en: 'Press <kbd>E</kbd> in the preview to open it. Vim keybindings are switched on in <kbd>⚙ Settings</kbd>.' },

    /* --- these 18 are byte-for-byte copies of the app's help.key.* --- */
    'keys.m':         { ja: 'ダーク / ライト表示の切り替え', en: 'Toggle dark / light appearance' },
    'keys.s':         { ja: 'スタイルの選択（行末の ⚙ でそのスタイル固有の設定。Marpモードでは Marpテーマ。フロントマターを書き換え）',
                        en: 'Choose a style (⚙ opens that style’s own settings; in Marp mode it picks the Marp theme and rewrites the front matter)' },
    'keys.n':         { ja: 'セクション自動番号の切り替え', en: 'Toggle automatic section numbering' },
    'keys.l':         { ja: '行番号の表示切り替え', en: 'Toggle line numbers' },
    'keys.w':         { ja: '全幅レイアウトの切り替え', en: 'Toggle full-width layout' },
    'keys.zoom':      { ja: 'ズームイン / アウト / リセット', en: 'Zoom in / out / reset' },
    'keys.e':         { ja: 'エディタウィンドウを開く（Vimモード・数式入力補助・文字数カウント）',
                        en: 'Open the editor window (Vim mode, math input assist, character count)' },
    'keys.ctrlN':     { ja: '新規の空Markdownファイルを作成', en: 'Create a new empty Markdown file' },
    'keys.ctrlD':     { ja: 'インストール先フォルダを Explorer で開く', en: 'Open the install folder in Explorer' },
    'keys.history':   { ja: '開いたファイルの履歴を戻る / 進む', en: 'Go back / forward through opened files' },
    'keys.ctrlClick': { ja: '.md リンクを新しいプレビュアのウィンドウで開く（通常のクリックは同じウィンドウで遷移）',
                        en: 'Open a .md link in a new previewer window (a plain click navigates in this window)' },
    'keys.x':         { ja: '現在の文書をエクスポート（保存ダイアログで HTML / PDF を選択。PDFはクリック可能なリンクと見出しのしおりを保持）',
                        en: 'Export the current document (pick HTML or PDF in the save dialog; PDF keeps clickable links and heading bookmarks)' },
    'keys.p':         { ja: 'Marp表示の切り替え: スクロール → デッキ → 一覧（一覧でサムネイルをクリックするとデッキで開く）',
                        en: 'Cycle the Marp view: scroll → deck → list (clicking a thumbnail in list view opens it in deck view)' },
    'keys.f':         { ja: '全画面表示の切り替え（Marp文書）', en: 'Toggle fullscreen (Marp documents)' },
    'keys.a':         { ja: 'スライドの自動縮小の切り替え（Marp）', en: 'Toggle shrink-to-fit for slides (Marp)' },
    'keys.slideNav':  { ja: '前 / 次のスライド（Marpデッキモード）',
                        en: 'Previous / next slide (Marp deck mode)' },
    'keys.slideEnds': { ja: '最初 / 最後のスライドへ（Marpデッキモード）',
                        en: 'Jump to the first / last slide (Marp deck mode)' },
    'keys.zoomPan':   { ja: 'カーソル位置でズーム / スライドをパン（Marpデッキモード）',
                        en: 'Zoom at the cursor / pan the slide (Marp deck mode)' },
    'keys.z':         { ja: '軌跡付きレーザーポインタの切り替え（Marpデッキモード）',
                        en: 'Toggle the laser pointer with trail (Marp deck mode)' },

    /* --- the two reworded rows (ADAPTED in docskeycheck.py) --- */
    'keys.h':   { ja: 'アプリ内のショートカット一覧の表示 / 非表示', en: 'Show / hide the in-app shortcut list' },
    'keys.esc': { ja: '開いているモーダルを閉じる（新しいものから順に）', en: 'Close the open modal (newest first)' },

    /* --- the only two KEY cells that go through i18n: they mix a key with a
           WORD, exactly the two the app routes through data-i18n-html. Copied
           from help.cell.*, with the class renamed kc -> sc-combo. --- */
    'keys.cell.ctrlClick': { ja: '<span class="sc-combo"><kbd>Ctrl</kbd>+クリック</span>',
                             en: '<span class="sc-combo"><kbd>Ctrl</kbd>+Click</span>' },
    'keys.cell.zoomPan':   { ja: '<span class="sc-combo"><kbd>Ctrl</kbd>+<kbd>Wheel</kbd> /</span> <span class="sc-combo">ドラッグ</span>',
                             en: '<span class="sc-combo"><kbd>Ctrl</kbd>+<kbd>Wheel</kbd> /</span> <span class="sc-combo">Drag</span>' },

    /* --- editor rows: no counterpart in the app's help modal, so not checked.
           Wording drawn from the editor's own ed.* hints in
           tools/build-editor/i18n.js. --- */
    'keys.ed.save':     { ja: '保存してプレビューへ反映（Vim では <code>:w</code> / <code>:wq</code>）',
                          en: 'Save, and the preview follows at once (<code>:w</code> / <code>:wq</code> under Vim)' },
    'keys.ed.indent':   { ja: 'インデント / 逆インデント。数式の中では入力補助が、番号付きリストの中ではマーカー幅への揃えが先に働きます',
                          en: 'Indent / outdent — inside math the input assist wins first, and inside a numbered list the indent snaps to the marker’s width' },
    'keys.ed.fontsize': { ja: '編集中の文字だけを拡大 / 縮小 / 既定へ（<kbd>Ctrl</kbd>+ホイール、<code>:fontsize</code> でも）',
                          en: 'Scale the editing text only, up / down / back to the default (<kbd>Ctrl</kbd>+wheel and <code>:fontsize</code> do it too)' },
    'keys.ed.paste':    { ja: 'Excel / Word の表を Markdown の表に変換して貼り付け（<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> で一回だけ素のまま、<kbd>Ctrl</kbd>+<kbd>Z</kbd> 一回で戻ります）',
                          en: 'Paste an Excel / Word table as a Markdown table (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> pastes raw just once; one <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes it)' },
    'keys.ed.slide':    { ja: 'Marp スライドを挿入 / コピー / カット（Vim では <code>gsi</code> / <code>gsy</code> / <code>gsd</code>）',
                          en: 'Insert / copy / cut a Marp slide (<code>gsi</code> / <code>gsy</code> / <code>gsd</code> under Vim)' },
    'keys.ed.table':    { ja: '表を挿入 / カーソル列のハイライトを切り替え（Vim では <code>gti</code> / <code>gtc</code>）',
                          en: 'Insert a table / toggle the cursor-column highlight (<code>gti</code> / <code>gtc</code> under Vim)' },
    'keys.ed.headings': { ja: '次 / 前の見出しへ移動、節を畳む / すべて畳む（Vim ノーマルモード）',
                          en: 'Next / previous heading, fold this section / fold them all (Vim NORMAL)' },
    'keys.ed.cells':    { ja: '<code>---</code> 区切りの Jupyter 風セルモードを切り替え、セルを実行して次へ（<code>:cellmode</code> でも）',
                          en: 'Toggle Jupyter-style cell mode with <code>---</code> as the separator, then run a cell and move on (<code>:cellmode</code> too)' },
    'keys.ed.jaword':   { ja: '漢字・ひらがな・カタカナの切れ目で止まる単語移動（Vim ノーマルモード。<code>:set dvorak</code> で Dvorak 配列にも対応）',
                          en: 'Word motions that stop at kanji / hiragana / katakana boundaries (Vim NORMAL; <code>:set dvorak</code> reads Command-mode keys at their QWERTY positions)' },

    'keys.note': { ja: '上の 3 つは、アプリの中で <kbd>H</kbd> を押すと出る一覧と同じものです。エディタの欄は主なものだけで、セルモードや Vim の全キー、ex コマンドの一覧はエディタの <kbd>⚙ 設定</kbd> と README でご覧いただけます。',
                   en: 'The first three groups are the same list the app itself shows under <kbd>H</kbd>. The editor group carries only the major bindings — the full cell-mode, Vim and ex-command reference lives in the editor’s <kbd>⚙ Settings</kbd> and in the README.' },

    'dl.kicker': { ja: 'GET IT', en: 'GET IT' },
    'dl.title':  { ja: '1 分で、使いはじめられます。', en: 'A minute from here to reading.' },
    'dl.lead':   { ja: 'インストーラは <code>%LOCALAPPDATA%</code> の下に入るので、管理者権限は要りません。アンインストールは Windows の「設定 → アプリ」から。',
                   en: 'The installer writes under <code>%LOCALAPPDATA%</code>, so it needs no admin rights. Uninstall from Windows Settings → Apps.' },
    'dl.cta':    { ja: 'インストーラをダウンロード', en: 'Download the installer' },
    'dl.req1t':  { ja: '動作環境', en: 'Requirements' },
    'dl.req1d':  { ja: 'Windows 10 / 11（64-bit）。<b>macOS・Linux には対応していません。</b>',
                   en: 'Windows 10 / 11 (64-bit). <b>There is no macOS or Linux build.</b>' },
    'dl.req2t':  { ja: '必要なランタイム', en: 'Runtime' },
    'dl.req2d':  { ja: 'Microsoft Edge WebView2。Windows 11 には標準搭載、Windows 10 でも最近の Edge が入っていれば揃っています。',
                   en: 'Microsoft Edge WebView2 — shipped with Windows 11, and already present on Windows 10 if you have a recent Edge.' },
    'dl.req3t':  { ja: 'ネットワーク', en: 'Network' },
    'dl.req3d':  { ja: '表示にはインターネット接続を使いません。tikz-cd のエンジンだけ、インストール時に取得するか選べます。',
                   en: 'Rendering never touches the internet. The tikz-cd engine is the one optional piece, fetched during setup if you tick the box.' },

    'foot.readme':   { ja: '使い方', en: 'How to use' },
    'foot.history':  { ja: '更新履歴', en: 'Release notes' },
    'foot.releases': { ja: 'リリース', en: 'Releases' },
    'foot.license':  { ja: 'ライセンス', en: 'Licence' },
    'foot.note':     { ja: 'MIT License · 収録ライブラリの表記はアプリ内のヘルプ（<kbd>H</kbd>）からご覧いただけます。',
                       en: 'MIT License · Third-party notices are listed in the app’s own help panel (<kbd>H</kbd>).' }
  };

  var LANG_KEY = 'uiLang';    /* same key the app itself uses */
  var THEME_KEY = 'siteTheme';
  var lang = 'ja';

  function t(key) {
    var m = I18N[key];
    if (!m) return key;                 /* loud in dev, never blank */
    return m[lang] || m.ja || key;
  }

  /* --------------------------------------------------------------- applying */
  function applyI18n(root) {
    root = root || document;

    root.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });

    /* Fed only from the constant table above -- never from user input. */
    root.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      el.innerHTML = t(el.getAttribute('data-i18n-html'));
    });

    root.querySelectorAll('[data-i18n-attr]').forEach(function (el) {
      el.getAttribute('data-i18n-attr').split(';').forEach(function (pair) {
        var i = pair.indexOf(':');
        if (i < 0) return;
        el.setAttribute(pair.slice(0, i).trim(), t(pair.slice(i + 1).trim()));
      });
    });

    /* Drives CJK line breaking and font fallback -- not cosmetic. */
    document.documentElement.lang = lang;
  }

  /* Several strings carry <code>/<b>/<kbd>, so the plain data-i18n path (which
     sets textContent) would print the tags. Promote those keys to the HTML
     path once, at boot, rather than hand-maintaining two attribute lists. */
  function promoteHtmlKeys() {
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var key = el.getAttribute('data-i18n');
      var m = I18N[key];
      if (!m) return;
      if (/[<>&]/.test(m.ja) || /[<>&]/.test(m.en || '')) {
        el.removeAttribute('data-i18n');
        el.setAttribute('data-i18n-html', key);
      }
    });
  }

  function detectLang() {
    var stored;
    try { stored = localStorage.getItem(LANG_KEY); } catch (e) { /* private mode */ }
    if (stored === 'ja' || stored === 'en') return stored;
    var list = navigator.languages || [navigator.language || 'en'];
    for (var i = 0; i < list.length; i++) {
      var L = String(list[i]);
      if (L === 'ja' || L.indexOf('ja-') === 0) return 'ja';  /* never 'ja*': "jam" is Jamaican Creole */
      if (L === 'en' || L.indexOf('en-') === 0) return 'en';
    }
    return 'ja';
  }

  function setLang(next, persist) {
    lang = (next === 'en') ? 'en' : 'ja';
    if (persist !== false) {
      try { localStorage.setItem(LANG_KEY, lang); } catch (e) { /* ignore */ }
    }
    document.querySelectorAll('[data-lang]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-lang') === lang));
    });
    applyI18n();
  }

  /* ----------------------------------------------------------------- theme */
  function setTheme(next, persist) {
    if (next) {
      document.documentElement.setAttribute('data-theme', next);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    if (persist !== false) {
      try {
        if (next) localStorage.setItem(THEME_KEY, next);
        else localStorage.removeItem(THEME_KEY);
      } catch (e) { /* ignore */ }
    }
  }

  function currentTheme() {
    var explicit = document.documentElement.getAttribute('data-theme');
    if (explicit) return explicit;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  /* ---------------------------------------------------------------- reveal */
  function wireReveal() {
    var items = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window) ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      items.forEach(function (el) { el.classList.add('static'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add('in');
        io.unobserve(e.target);
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.05 });
    items.forEach(function (el) { io.observe(el); });
  }

  /* --------------------------------------------------- latest release badge */
  /* Kept out of the markup on purpose: a hard-coded version is a maintenance
     trap that goes stale the next time the release hook bumps it. Failure here
     is silent -- the button reads fine with no version at all. */
  function fillVersion() {
    var slots = document.querySelectorAll('.ver');
    if (!slots.length || !window.fetch) return;
    fetch('https://api.github.com/repos/yvvakimoto/md_previewer/releases/latest',
          { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var tag = j && j.tag_name;
        if (!tag) return;
        slots.forEach(function (el) { el.textContent = tag; });
      })
      .catch(function () { /* offline, rate-limited, private repo: show nothing */ });
  }

  /* ------------------------------------------------------------------ boot */
  function boot() {
    promoteHtmlKeys();
    setLang(detectLang(), false);

    var stored = null;
    try { stored = localStorage.getItem(THEME_KEY); } catch (e) { /* ignore */ }
    if (stored === 'dark' || stored === 'light') setTheme(stored, false);

    document.querySelectorAll('[data-lang]').forEach(function (b) {
      b.addEventListener('click', function () { setLang(b.getAttribute('data-lang')); });
    });

    var themeBtn = document.getElementById('theme-btn');
    if (themeBtn) {
      themeBtn.addEventListener('click', function () {
        setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
      });
    }

    /* Another tab of this page changed the shared uiLang key. Fires only in
       *other* documents, so there is no loop; persist=false anyway. */
    window.addEventListener('storage', function (e) {
      if (e.key === LANG_KEY && (e.newValue === 'ja' || e.newValue === 'en')) {
        setLang(e.newValue, false);
      }
    });

    wireReveal();
    fillVersion();
  }

  document.documentElement.classList.remove('no-js');
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* Exposed for the harness / console poking, mirroring window.__I18N in the app. */
  window.__I18N = I18N;
})();
