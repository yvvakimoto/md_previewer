---
title: 下書きサンプル
watermark: DRAFT
---

# 任意透かし (watermark) デモ

この文書は front-matter に `watermark: DRAFT` を含みます。プレビューを開くと
`confidential: true` と同じオーバーレイ機構が働き、ページ全体に「DRAFT」の文字が
斜めに重なって表示されます。

## 仕組み

- **`watermark: <文字列>`** — 背景透かしの文言を自由に指定できます（`DRAFT` /
  `社外秘` / `SAMPLE` など）。オーバーレイの色・書体・角度・サイズは従来どおり
  各テーマ CSS が決め、文字列だけが差し替わります。
- `confidential: true` は従来どおり「CONFIDENTIAL」（テーマ既定）を表示します。
  両方を書いた場合は `watermark:` の文言が優先されます。
- `S` キーでテーマを切り替えると、文言は `DRAFT` のまま色・書体がテーマに追従します。
- `M` キーのライト / ダーク、`X` キーの HTML / PDF エクスポートにもそのまま反映されます。

> 機密指定ではなく単なる「下書き」表示にしたいときは、`confidential:` ではなく
> `watermark: DRAFT` を使ってください。
