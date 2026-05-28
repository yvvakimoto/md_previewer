# Schemata

`schemata` フェンスは複数種類の図解（マトリクス / BMC / マンダラチャート / 特性要因図 / フロー / サイクル）を `schemata.js` でレンダリングします。色は `#c-teal` / `#c-coral` / `#c-blue` / `#c-amber` / `#c-purple` / `#c-green` / `#c-pink` / `#c-gray` のタグで指定できます。

`title:` と同じ位置で `scale: <倍率>` を指定すると、図全体の表示倍率を変更できます（例: `scale: 0.7` で 70%、`scale: 1.5` で 150%）。1 より大きい値を指定した場合は `max-width:100%` 制限を外し、コンテナ幅を超えて表示します。

## Matrix (SWOT)

```schemata
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

## Business Model Canvas

```schemata
bmc
title: Business Model Canvas

- KP / Key Partners #c-gray
  - 主要サプライヤー
  - 戦略的提携先

- KA / Key Activities #c-teal
  - 製品開発
  - マーケティング

- VP / Value Propositions #c-coral
  - 高品質
  - カスタマイズ性

- CR / Customer Relationships #c-blue
  - 専任サポート
  - コミュニティ

- CS / Customer Segments #c-purple
  - 中小企業
  - エンタープライズ

- KR / Key Resources #c-teal
  - 技術基盤
  - 人材

- C$ / Cost Structure #c-amber
  - 開発コスト
  - 人件費

- CH / Channels #c-blue
  - Webサイト
  - 代理店

- R$ / Revenue Streams #c-green
  - サブスクリプション
  - ライセンス販売
```

## Mandara Chart

```schemata
mandara
title: 目標達成

- 中心目標
  - 技術
    - 学習
    - 実装
    - レビュー
    - 検証
    - 発信
    - 改善
    - 記録
    - 継続
  - 体力
    - 睡眠
    - 運動
    - 食事
    - 休息
    - 姿勢
    - 水分
    - 散歩
    - ストレッチ
  - メンタル
    - 瞑想
    - 読書
    - 目標設定
    - 振り返り
    - 感謝
    - 挑戦
    - 余白
    - 笑顔
  - 習慣
    - 早起き
    - 計画
    - 記録
    - 片付け
    - 準備
    - 節制
    - 集中
    - 反復
  - 人間関係
    - 挨拶
    - 傾聴
    - 感謝
    - 共有
    - 貢献
    - 誠実
    - 相談
    - 協力
  - 学習
    - 本
    - 記事
    - 動画
    - 実践
    - 議論
    - 執筆
    - 復習
    - 教える
  - 創造
    - 発想
    - 試作
    - 検証
    - 磨く
    - 発表
    - 反応
    - 改善
    - 再挑戦
  - 成果
    - 目標
    - 計測
    - 達成
    - 共有
    - 称賛
    - 次へ
    - 記録
    - 蓄積
```

## Fishbone (horizontal)

```schemata
fishbone
title: 特性要因図

- 納期遅延の原因
  - 人材 / Manpower
    - スキル不足
    - 人員不足
  - 方法 / Method
    - プロセスが複雑
    - レビュー不足
  - 機械 / Machine
    - ビルド環境の不備
    - テスト自動化不足
  - 材料 / Material
    - 要件の曖昧さ
    - 仕様変更の多さ
  - 環境 / Environment
    - 時差
    - ネットワーク不安定
  - 測定 / Measurement
    - KPI未設定
    - 品質基準の不明確
```

## Fishbone (vertical)

```schemata
fishbone vertical
title: 品質問題の分析

- 製品不良率の増加
  - 設計
    - 設計レビュー不足
    - 公差設定の甘さ
  - 製造
    - 作業手順の逸脱
    - 設備メンテ不足
  - 検査
    - 検査基準の曖昧さ
    - 測定器の校正漏れ
  - 材料
    - 受入検査の省略
    - サプライヤー品質低下
```

## Flow

```schemata
flow
title: リリースフロー

- 設計 #c-teal
  - 要件定義
  - 仕様策定

- 実装 #c-blue
  - コーディング
  - レビュー

- リリース #c-green
  - デプロイ
  - 監視
```

## Scale (縮小表示)

```schemata
matrix 2x2
title: SWOT分析 (70%表示)
scale: 0.7

- 強み #c-teal
  - 独自技術
- 弱み #c-coral
  - 人材不足
- 機会 #c-blue
  - 新興国市場
- 脅威 #c-amber
  - 競合の台頭
```

## Cycle

```schemata
cycle
title: PDCA

- Plan #c-teal
  - 目標設定
  - 計画策定

- Do #c-blue
  - 実行
  - 記録

- Check #c-amber
  - 評価
  - 分析

- Act #c-coral
  - 改善
  - 標準化
```
