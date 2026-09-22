# tikz-cd 可換図式

**tikzcd** フェンスは [tikz-cd](https://ctan.org/pkg/tikz-cd) 記法の**可換図式（commutative diagram）**を、バンドルした WASM 版 TeX エンジン [@rod2ik/tikzjax](https://www.npmjs.com/package/@rod2ik/tikzjax) でインライン SVG に描画します。**完全オフライン**（初回だけエンジンを遅延ロード）で、ダーク/ライト表示・HTML/PDF エクスポート・Marp スライドにそのまま対応します。斜め矢印や曲線矢印など tikz-cd の表現力をそのまま使えます。

> エンジンは初回コンパイルに数秒かかります（以降はメモ化されるので編集中も軽快）。図の色は現在のテーマに追従します。図は小さめなので既定で **1.6 倍**に拡大されます。個別に変えたいときは先頭行に `scale: 2` のように書きます。

## 拡大率の指定（`scale:`）

先頭行の `scale: <倍率>` で、その図だけ拡大率を変えられます（既定 1.6）。

```tikzcd
scale: 2.2
A \arrow[r, "f"] \arrow[d, "g"'] & B \arrow[d, "h"] \\
C \arrow[r, "k"']                & D
```

## 基本の可換正方形

tikzcd フェンスの中身は自動的に `tikzcd` 環境で囲まれます。

```tikzcd
A \arrow[r, "f"] \arrow[d, "g"'] & B \arrow[d, "h"] \\
C \arrow[r, "k"']                & D
```

## 斜め矢印（三角図式）

```tikzcd
A \arrow[r, "\phi"] \arrow[rd, "\psi"'] & B \arrow[d, "\pi"] \\
                                        & C
```

## ラベル・曲線・二重矢印

```tikzcd
X \arrow[r, shift left, "f"] \arrow[r, shift right, "g"'] & Y \arrow[r, "h"] & Z \\
A \arrow[rr, bend left=40, "u"] \arrow[rr, bend right=40, "v"'] & & B
```

## pullback / pushout

```tikzcd
P \arrow[r, "p_1"] \arrow[d, "p_2"'] \arrow[rd, phantom, "\lrcorner", very near start] & X \arrow[d, "f"] \\
Y \arrow[r, "g"'] & Z
```

## 生の TikZ 図

同じエンジンで一般的な TikZ 図も描けます（tikz-cd ではなく tikzpicture を直接記述する **tikz** フェンス）。

```tikz
\begin{tikzpicture}
  \draw[thick,->] (0,0) -- (2.2,0) node[right]{$x$};
  \draw[thick,->] (0,0) -- (0,2.2) node[above]{$y$};
  \draw[blue,thick] (0,0) .. controls (1,2) and (2,0) .. (2.2,1.6);
\end{tikzpicture}
```

## AMS 数式コマンド（`\mathbb` など）

`amsmath` と `amssymb` が**既定で読み込まれる**ので、`\mathbb{R}` `\mathfrak{g}`
`\varnothing` などの AMS 記号と、`\text{…}` `\dfrac` といった amsmath のコマンドが
`tikz` / `tikzcd` **どちらのフェンスでも同じように**使えます。

```tikz
\begin{tikzpicture}
  \draw[thick,->] (-0.3,0) -- (3.6,0) node[right]{$x \in \mathbb{R}$};
  \draw[thick,->] (0,-0.2) -- (0,1.9);
  \draw[blue,thick] (0.1,0.15) .. controls (1.2,1.9) and (2.0,1.9) .. (3.3,0.15);
  \node at (1.7,2.4) {$\dfrac{1}{\sqrt{2\pi}}\,e^{-x^{2}/2} \quad \text{(標準正規分布)}$};
\end{tikzpicture}
```

## 日本語ラベル

セルにも矢印ラベルにも**日本語がそのまま書けます**。同梱の TeX エンジン自体は日本語を組版できない（欧文フォントしか持たない）ため、TeX には文字の**枠だけ**を確保させ、字はブラウザのフォントで SVG に描いています。矢印ラベルは tikz-cd の仕様で一段小さい文字なので、日本語もそれに追従します。

```tikzcd
集合 \arrow[r, "写像 f"] \arrow[d, "包含"'] & 群 \arrow[d, "準同型 h"] \\
環 \arrow[r, "k"']                          & 体
```

生の `tikz` フェンスでも同じように使えます（回転させたラベルも追従します）。

```tikz
\begin{tikzpicture}
  \draw[thick,->] (0,0) -- (3.2,0) node[right]{時間 $t$};
  \draw[thick,->] (0,0) -- (0,2.2) node[above]{速度 $v$};
  \draw[red,thick] (0,0) .. controls (1.5,0.2) .. (3,1.8);
  \node[rotate=30] at (1.6,1.4) {加速区間};
\end{tikzpicture}
```

**色指定も日本語に効きます。** `\node[red]` / `text=` / `\begin{scope}[blue]` / `\textcolor{…}` のどれで指定しても、同じラベルの欧文と同じ色になります。

```tikz
\begin{tikzpicture}
  \node[red] at (0,0)   {赤い日本語 red};
  \node[text=blue] at (4,0) {青い日本語 blue};
  \node at (8,0)        {\textcolor{green!60!black}{緑の日本語 green}};
  \draw[orange,thick,->] (0,-1) -- (8,-1) node[midway,above]{橙の矢印ラベル};
\end{tikzpicture}
```

> 文字は**閲覧している PC の日本語フォント**で描かれます。HTML エクスポートした図を日本語フォントの無い環境で開くと、この部分だけ別のフォントに置き換わります（欧文の Computer Modern は SVG に埋め込まれるので影響を受けません）。ギリシャ文字・キリル文字は未対応なので、`\alpha` のようなコマンドを使ってください。色は `rgb` / `gray` 系の指定のみ反映され、`cyan` `magenta` `yellow` や `\color[cmyk]{…}`・dvipsnames の色名はエンジン側の制約でテーマ色になります（これは**欧文も同じ**なので、ラベルの片側だけ色が付くことはありません）。

## エラー時の挙動

不正な TeX は他の図に影響を与えず、その場に赤枠のエラーとして表示されます。

```tikzcd
A \arrow[r, "f" & B
```
