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

![テスト画像|1000](images/test.png)

---

## Mermaid 図

本ツールの拡張なので Marp 単体では描画されませんが、こちらは正しく SVG に展開されます。

```mermaid
graph LR
  A[編集] --> B[保存]
  B --> C{Marp?}
  C -->|Yes| D[スライド表示]
  C -->|No| E[通常プレビュー]
```

---

## SmartArt

```smartart
matrix 2x2
title: SWOT分析

- 強み / Strength #c-teal
  - 独自技術
  - ブランド認知度

- 弱み / Weakness #c-coral
  - 人材不足
  - 海外展開の経験が浅い

- 機会 / Opportunity #c-blue
  - 新興国市場
  - デジタル化の加速

- 脅威 / Threat #c-amber
  - 競合の台頭
  - 原材料コスト上昇
```
---

## CSV テーブル

```csv
項目,Q1,Q2,Q3,Q4
売上,120,150,170,210
利益,30,42,55,68
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

Marp 標準では脚注は未対応ですが、本ツールでは有効です[^impl]。スライド本体にリンクが付き、末尾のスライドにまとめて表示されます[^export]。

[^impl]: `[^id]` 構文を marp-core に渡す前にプレースホルダ化し、レンダリング後に `<sup>` に戻す方式です。
[^export]: HTML エクスポートでもそのまま保持されます。
