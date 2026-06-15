# Plotly チャート (外部CSV)

`plotly` フェンスブロックに「CSV/TSV ファイルパス＋描画設定 (YAML)」を書くと、
[Plotly.js](https://plotly.com/javascript/) によって対話的なグラフがプレビュー内に
直接描画される。CSV ファイルが更新されると自動でグラフも追従する。

レイアウトの `width` / `height` (ピクセル単位) で表示サイズを指定する。
`width` を省略すると幅は親要素に追従、`height` を省略すると Plotly の既定値 (450 px)。

## 1. 折れ線 (line)

```plotly
file: data/sales.csv
type: line
x: month
y: revenue
title: Monthly Revenue (2025)
layout:
  height: 380
  xaxis: { title: Month }
  yaxis: { title: USD (1,000) }
```

## 2. 散布図 (scatter)

```plotly
file: data/scatter.csv
type: scatter
x: x
y: y
mode: markers
title: XY scatter
layout:
  height: 380
```

## 3. 複数系列 (line, y がリスト)

```plotly
file: data/sales.csv
type: line
x: month
y: [revenue, cost]
names: [Revenue, Cost]
title: Revenue vs Cost
layout:
  height: 420
```

## 4. 棒グラフ (bar)

```plotly
file: data/sales.csv
type: bar
x: month
y: units
title: Units Sold
layout:
  height: 380
  yaxis: { title: Units }
```

## 5. ヒストグラム (histogram)

```plotly
file: data/samples.csv
type: histogram
x: value
title: Distribution of sample values
layout:
  height: 360
```

## 6. 箱ひげ (box)

```plotly
file: data/samples.csv
type: box
y: value
title: Box plot
layout:
  height: 360
  width: 480
```

## 7. ヒートマップ (heatmap)

1列目を Y 軸、ヘッダ行を X 軸、残りセルを Z として行列形式で読み込む。

```plotly
file: data/heatmap.csv
type: heatmap
title: Weekly hourly intensity
layout:
  height: 460
```

## 8. 3D サーフェス (surface)

```plotly
file: data/surface.csv
type: surface
title: z = x² + y²
layout:
  height: 560
```

## 9. 高度な構文: `traces:` リスト

各トレースを Plotly ネイティブ仕様に近い形でフルコントロールできる。
`x:` / `y:` に文字列を書くと CSV の列名として解決される。

```plotly
file: data/sales.csv
traces:
  - type: scatter
    x: month
    y: revenue
    name: Revenue
    mode: lines+markers
  - type: bar
    x: month
    y: cost
    name: Cost
layout:
  title: P&L (mixed line + bar)
  barmode: group
  height: 440
```
