---
marp: true
theme: magenta
paginate: true
---


<!-- _class: title -->

# スライドプレビュー

## Marp機能の概説

---

<!-- _class: section -->

## Part I

# 章表示

---

## Marp プレビュー機能

このファイルは、本ツールで Marp 形式のスライドをそのままプレビューできることを示すサンプルです。

- フロントマターに `marp: true` を書くだけで自動切替
- `P` キーで デッキモード（1 枚ずつ表示）に切替
- `←` / `→` でスライド移動、`F` でフルスクリーン
- `theme: newton` のように `assets/marp/*.css` の独自テーマも指定可能

---

## 数式と画像

Marp 標準の KaTeX で数式が描画されます。

$$
\int_{0}^{\infty} e^{-x^2}\, dx = \frac{\sqrt{\pi}}{2}
$$

インライン数式 $E = mc^2$ もそのまま動きます。

---

## ローカル画像

相対パスのローカル画像は Rust 側で base64 にインライン化されます。

![テスト画像|600](images/test.png)

---

## 動画 / YouTube

画像記法 `![](…)` を流用して動画も埋め込めます。ローカル動画は `<video controls>`、YouTube URL はレスポンシブ `<iframe>` になります。

![紹介動画|560](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

---

## ローカル動画

`![alt|幅](videos/sample.mp4)` でこのファイルからの相対パス動画を再生（シーク対応）。`X` エクスポート時は `media/` にコピーされます。

![デモ動画|560](videos/sample.mp4)

---

## Mermaid 図

本ツールの拡張なので Marp 単体では描画されませんが、こちらは正しく SVG に展開されます。先頭に `scale: <倍率>` を書くと図全体を拡大／縮小できます（例: `scale: 1.5` で 150%）。

```mermaid
scale: 1.5
graph LR
  A[編集] --> B[保存]
  B --> C{Marp?}
  C -->|Yes| D[スライド表示]
  C -->|No| E[通常プレビュー]
```

---

## ABC 楽譜

本ツールの拡張により、`abc` フェンスで [ABC 記譜法](https://abcnotation.com/) が五線譜として描画されます。図中央寄せの対象なので、スライド内で縦方向に整列します。

```abc
X:1
T:メヌエット風
M:3/4
L:1/4
K:G
D | G2 A | B2 c | d2 e | d3 | c2 A | B2 G | A2 D | G3 |
```

---

## CSV テーブル

```csv
項目,Q1,Q2,Q3,Q4
売上,120,150,170,210
利益,30,42,55,68
```

---

## Plotly チャート (外部CSV)

```plotly
file: data/sales.csv
type: line
x: month
y: [revenue, cost]
names: [Revenue, Cost]
title: Monthly P&L
layout:
  height: 420
  margin: { t: 48, r: 24, b: 48, l: 56 }
  legend: { orientation: h, y: -0.2 }
```

---

## Plotly: 3D サーフェス

```plotly
file: data/surface.csv
type: surface
title: z = x² + y²
layout:
  height: 480
  margin: { t: 40, r: 0, b: 0, l: 0 }
  scene: { camera: { eye: { x: 1.4, y: 1.4, z: 0.9 } } }
```

---

## シンタックスハイライト

```rust
fn main() {
    println!("Hello, Marp!");
}
```

---

## 脚注

Marp 標準では脚注は未対応ですが、本ツールでは有効です[^impl]。参照元と同じスライドの下部に、そのスライドの脚注だけがコンパクトに表示されます[^placement]。番号は全スライド通しで振られます[^export]。

[^impl]: `[^id]` 構文を marp-core に渡す前にプレースホルダ化し、レンダリング後に `<sup>` に戻す方式です。
[^placement]: 各スライド末尾に小さめのフォントで配置されます。
[^export]: HTML エクスポートでもそのまま保持されます。

---

<!-- _class: split -->

## 2カラムレイアウト

### 基本記法

Marp 標準では生 HTML が必要な「左右分割」を、`<!-- _class: split -->` ディレクティブと `+++` 区切りだけで実現できます。

- 左側に説明文
- 右側に箇条書きや画像
- `+++` を行頭単独で書くと列が分かれる

+++

### 使いどころ

- ビフォー / アフターの比較
- 図と説明を並べる
- メリット / デメリット表

コードフェンス内の `+++` は分割されません:

```diff
+++ a/file.txt
--- b/file.txt
```

---

## スライド途中からのカラム

通常は1カラムで導入文を書きます。`<!-- _class: split -->` と違いスライド全体を分割しません。

::: columns
### 左カラム

- `::: columns` で領域を開始
- 内部の `+++` で列を区切る
- 列内に `::: center` も使える

+++

### 右カラム

::: center
**中央寄せ**も列内で機能
:::
:::

`:::` で領域を閉じると、再び全幅の1カラムに戻ります。`::: columns-3` のように列数を明示することもできます（既定は `+++` の数で自動）。

---

## 強調メッセージ

`::: message` … `:::` で囲むと、中央寄せ＋大きな太字＋上下のアクセント罫で強調表示されます。
結論やキーメッセージを読みやすく提示したいときに使います。

::: message
結論：このまま進めて問題ありません
:::

`::: center` が配置だけなのに対し、`::: message` は文字サイズ・太さ・罫線で視覚的に強調します。

---

<!-- _class: split-3 -->

## 3カラム特徴紹介

### シンプル

`+++` を 2 回書くだけで 3 カラムに展開されます。`split-4` で 4 カラムまで対応。

+++

### 柔軟

各カラムには見出し、リスト、コード、画像、数式、脚注、mermaid まで配置できます。

+++

### 安全

`html: false` を維持したまま実現しているため、Marp 標準のセキュリティモデルから逸脱しません。

---

<!-- _class: split -->

## カラム内の楽譜

### 説明

`split` レイアウトの各カラムにも `abc` 楽譜を配置できます。

- 左に解説、右に譜面
- SVG に viewBox を付与して描画するので、狭いカラム幅でも途切れず自動で縮小

+++

### 譜面例

```abc
X:1
T:練習曲
M:4/4
L:1/4
K:C
C E G c | c G E C | D F A d | d A F D |
```
