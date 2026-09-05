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

## エラー時の挙動

不正な TeX は他の図に影響を与えず、その場に赤枠のエラーとして表示されます。

```tikzcd
A \arrow[r, "f" & B
```
