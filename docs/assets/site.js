/* ==========================================================================
   MD Previewer for Windows — landing page behaviour
   Language toggle, theme toggle, scroll reveal, latest-version badge.

   The i18n layer deliberately mirrors the app's own convention (see the
   "UI Language" section of CLAUDE.md): data-i18n / data-i18n-html /
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
    'use2.alt1':  { ja: 'グラデーションの章扉スライド', en: 'A gradient section-divider slide' },
    'use2.alt2':  { ja: 'Mermaid のフローチャートを載せたスライド', en: 'A slide carrying a Mermaid flowchart' },
    'use2.alt3':  { ja: 'Plotly の 3D サーフェスを載せたスライド', en: 'A slide carrying a Plotly 3D surface' },

    'use3.chip':  { ja: '研究する人へ', en: 'for researchers' },
    'use3.title': { ja: '数式を、書く速さで。', en: 'Math at the speed of writing.' },
    'use3.body':  { ja: 'KaTeX がインラインもディスプレイも組みます。数式を右クリックすれば <b>MathML</b> と <b>LaTeX</b> をコピーでき、Word にそのまま貼れます。内蔵エディタには YaTeX 風の入力支援 — <code>$</code>+Tab、<code>\\begin{}</code>+Tab、<code>a.</code>→<code>\\alpha</code>。可換図式は tikz-cd をそのまま書けば、WASM 版 TeX がオフラインで組みます。',
                    en: 'KaTeX sets both inline and display math. Right-click any formula to copy it as <b>MathML</b> or <b>LaTeX</b> and paste it straight into Word. The built-in editor adds YaTeX-style input assist — <code>$</code>+Tab, <code>\\begin{}</code>+Tab, <code>a.</code>→<code>\\alpha</code> — and commutative diagrams are plain tikz-cd, typeset offline by a WebAssembly TeX engine.' },
    'use3.p1':    { ja: 'KaTeX', en: 'KaTeX' },
    'use3.p2':    { ja: 'MathML / LaTeX コピー', en: 'Copy as MathML / LaTeX' },
    'use3.p3':    { ja: '数式入力支援', en: 'Math input assist' },
    'use3.p4':    { ja: 'tikz-cd 可換図式', en: 'tikz-cd diagrams' },
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
    'feat.lead':     { ja: '素の Markdown では足りない、と思ったときの記法とエンジンをひととおり揃えました。追加インストールも、ネットワークも要りません。',
                       en: 'The notations and engines you reach for when plain Markdown runs out — all here, with nothing to install and no network to reach.' },
    'feat.credit':   { ja: '描画の中身は、上に挙げた各オープンソースプロジェクトの成果です。タイルをクリックすると本家のサイトへ移動します。ライセンス全文はアプリに収録してあり、ヘルプ（<kbd>H</kbd>）→ サードパーティ表記から読めます。作者のみなさんに感謝します。ほかに CSV / TSV 表、脚注、定義リスト、タスクリスト、機密透かし、ワークスペースなども使えます。',
                       en: 'The rendering itself is the work of the open-source projects above — each tile links to its upstream, and the full licence texts ship with the app under Help (<kbd>H</kbd>) → Third-party licenses. Thank you to their authors. Also included: CSV / TSV tables, footnotes, definition lists, task lists, confidential watermarks and workspaces.' },

    'lib.marked':    { ja: 'Markdown 本文の解析', en: 'Parses the Markdown itself' },
    'lib.hljs':      { ja: 'コードの色分け', en: 'Colours the code blocks' },
    'lib.katex':     { ja: 'インライン / ディスプレイ数式', en: 'Inline and display math' },
    'lib.mermaid':   { ja: 'フロー・シーケンス・ガント', en: 'Flow, sequence, Gantt' },
    'lib.marp':      { ja: '16:9 スライドの組版', en: 'Typesets the 16:9 deck' },
    'lib.plotly':    { ja: '外部 CSV から対話グラフ', en: 'Interactive charts from a CSV' },
    'lib.abcjs':     { ja: 'ABC 記譜法を五線譜に', en: 'ABC notation as staff notation' },
    'lib.markwhen':  { ja: '年表・カレンダー', en: 'Timelines and calendars' },
    'lib.tikz':      { ja: 'tikz-cd の可換図式（任意導入）', en: 'tikz-cd diagrams (opt-in)' },
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
