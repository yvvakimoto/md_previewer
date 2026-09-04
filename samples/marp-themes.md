---
marp: true
theme: gold
paginate: true
confidential: true
---

<!-- _class: title -->

# カラーバリエーション

## magenta ファミリーの配色見本

S キーでテーマを切り替え、⚙ で「テーマ色」を動かすと配色全体が追随します

---

<!-- _class: section -->

## Part I

# 章スライド

---

## 本文要素

### 見出し 3 は罫線色

- 箇条書きと **強調（アクセント濃）** と `インラインコード`
- [リンク](https://marp.app/) はアクセント色、下線付き
- 透かし（`confidential: true`）もテーマ色で着色

> 引用は罫線色の淡い地に載ります。
> -- 出典の行は右寄せ

---

## 表とコード

| 項目 | Q1 | Q2 | Q3 |
|---|---:|---:|---:|
| 売上 | 120 | 150 | 170 |
| 利益 | 30 | 42 | 55 |
| 費用 | 90 | 108 | 115 |

```rust
fn main() {
    println!("Hello, {}!", "theme");   // 地は --code-bg、左罫はアクセント
}
```

---

## 強調メッセージと定義リスト

::: message
配色はテーマ色 1 つから導かれます
:::

テーマ色
: `--theme-color`。⚙ で変えると、見出し・罫線・コード地・透かし・レーザーまで追随します。

明度
: デザイン側で固定。淡い色を選んでも見出しは読める濃さを保ちます。

---

<!-- _class: invert -->

## 反転スライド（`_class: invert`）

同じテーマ色から導いた**暗色セット**に切り替わります。表の行やコードの地も暗くなります。

| 項目 | 値 |
|---|---:|
| A | 1 |
| B | 2 |

`code` と **強調** と [リンク](https://marp.app/)、そして

> 引用。章スライドのグラデーションは反転しても淡くなりません。

---

## テーマの切り替えと調整

1. **S キー** — `magenta` / `indigo` / `purple` / `green` / `gold` / `silver` / `black` / `dark` から選ぶ（front-matter の `theme:` が書き換わります）
2. **⚙（選択中のテーマの行）** — 「テーマ色」ピッカー 1 つ。色相と鮮やかさが全トークンに反映され、明度は固定
3. 調整値は**テーマごと**に保存され、`X` キーの HTML / PDF 書き出しにも反映されます

---

## 自作バリエーション

`assets/marp/mytheme.css` を置くだけで S キーの一覧に並びます。

```css
/* @theme mytheme */
@import "magenta";
:root {
  --theme-color: #00695c;
  /* magenta.css の :root を写し、L / K / ΔH を好みに変える */
  --accent: oklch(from var(--theme-color) 0.5313 c h);
}
```

`/* @user-vars … */` を末尾に書けば ⚙ も付きます。
