---
title: 機密文書サンプル
confidential: true
---

# 機密表示 (Confidential) デモ

この文書は front-matter に `confidential: true` を含みます。プレビューを開くと
`body.confidential` クラスが付与され、ページ全体に既定の「CONFIDENTIAL」透かしが
斜めに重なって表示されます。

## 仕組み

- **切り替え**: front-matter の `confidential: true` の 1 行だけ。文書ごとに固定です。
  `false` にする（または行を消す）と、自動リロードで透かしが消えます。
- **見た目は各テーマ CSS が定義**: `index.html` は `body.confidential` クラスの
  付与だけを行い、透かしの文言・色・大きさ・角度は各 CSS が `--confidential-*`
  カスタムプロパティで上書きします。
- **エクスポートに反映**: `X` キーで HTML / PDF に書き出すと、`body.confidential`
  クラスと透かしがそのまま成果物にも乗ります。

## テーマ別の見え方を試す

`S` キーでスタイルを切り替えると、テーマごとに透かしの色・書体が変わります。

| テーマ | 透かし |
| --- | --- |
| Default | 赤の CONFIDENTIAL（既定） |
| parchment | セピアの CONFIDENTIAL |
| classical | ワインレッドの CONFIDENTIAL（明朝） |
| hakuro-modern | ローズの CONFIDENTIAL（ゴシック） |
| tategaki | 縦組みの「社外秘」 |

`M` キーでライト / ダークを切り替えても表示が保たれます。

## カスタムプロパティ

各テーマ CSS で以下を上書きできます（`#preview` / `:root` / `section` のいずれに
設定しても継承されます）。

- `--confidential-label` — 表示文字列（既定 `"CONFIDENTIAL"`）
- `--confidential-color` — 透かし色
- `--confidential-size` — 文字サイズ
- `--confidential-angle` — 回転角（既定 `-30deg`）
- `--confidential-font` — フォント
- `--confidential-opacity` — 不透明度（`0` で完全に非表示）

> 例えば `--confidential-opacity: 0` を指定すれば、そのテーマでは透かしを
> まったく出さないこともできます。
