# Feynman 図（feynmark）

**feynman** フェンスは [feynmark](https://github.com/yvvakimoto/feynmark)（MIT）の DSL で書いた**ファインマン図**を、インライン SVG として描画します。`diagram { ... }` / `equation { ... }` の 1 つ以上の宣言をフェンス内に書けます。線種（フェルミオン・光子・グルーオン・スカラー…）や運動量ラベル、頂点の装飾を宣言的に指定するだけで、外部脚の配置から内部頂点のレイアウトまで自動で決まります（feynMF 法によるテンション最小化）。ダーク/ライト表示・HTML エクスポート・Marp スライドにそのまま対応します（`currentColor` で描画されるため再描画なしでテーマに追従）。ラベルは [KaTeX](https://katex.org/)（本アプリに同梱）で組版されます。

## 基本の tree レベル図

```feynman
diagram tree {
  in  e1: $e^-$,  e2: $e^+$
  out m1: $\mu^-$, m2: $\mu^+$
  e1 -- [fermion] a -- [fermion] e2
  a  -- [photon, momentum=$q$] b
  m2 -- [fermion] b -- [fermion] m1
}
```

## 線種（プロパゲータスタイル）

`fermion` / `photon` / `gluon` / `scalar` など、線種は角括弧の属性で指定します。

```feynman
diagram { in a: $e^-$; out b: $e^-$; a -- [fermion, label=$e^-$] b }
diagram { in a; out b; a -- [photon, label=$\gamma$] b }
diagram { in a; out b; a -- [gluon, label=$g$] b }
```

## 自己エネルギーループ

`loop=up`（自己ループ）や `bend left`（湾曲脚）で高次補正も表現できます。

```feynman
diagram [scale=1.4] {
  in a: $e^-$; out b: $e^-$
  a -- [fermion] v -- [fermion] b
  v -- [photon, loop=up, label=$\gamma$] v
}
```

## 数式への埋め込み（equation）

`equation { ... }` の中で `@name` を書くと、先に定義した `diagram` がその項として式に埋め込まれます（同じフェンス内の宣言だけを参照可能）。

```feynman
diagram lo {
  in  e1: $e^-$, e2: $e^+$
  out m1: $\mu^-$, m2: $\mu^+$
  e1 -- [fermion] a -- [fermion] e2
  a -- [photon] b
  m2 -- [fermion] b -- [fermion] m1
}
diagram nlo {
  in  e1: $e^-$, e2: $e^+$
  out m1: $\mu^-$, m2: $\mu^+$
  e1 -- [fermion] a -- [fermion] e2
  a -- [photon] b
  m2 -- [fermion] c -- [fermion] b -- [fermion] d -- [fermion] m1
  c -- [photon, bend right=60, label'=$\gamma$] d
}
equation amp {
  i\mathcal{M}(e^+e^-\to\mu^+\mu^-) = @lo \;+\; @nlo \;+\; \mathcal{O}(\alpha^3)
}
```

## エラー時の挙動

不正な構文は他の図に影響を与えず、その場に赤枠のエラーとして表示されます。

```feynman
diagram broken {
  in a: $e^-$; out b: $e^-$
  a -- [fermion] v1 -- [fermion] v2 -- [fermion] b
  v1 -- [photon, bend left=75] v2
  ...
}
```
