# Kataskeve3D — 立体幾何の作図ブロック

`kataskeve3d` フェンスは空間図形（球・円柱・円錐・トーラス・多面体・パラメトリック曲面）を 2D 版と同系の DSL で記述し、**ペン画風の陰線処理つきラスタ図**として描きます。隠れた稜線の除去は陰関数のレイマーチで解析的に行われ、`shading: on` で点描（スティプル）による Lambert 陰影が付きます。

エンジンは外部パッケージ [kataskeve3d](https://github.com/yvvakimoto/kataskeve3d)（MIT）を同梱したもので、依存ゼロ・完全オフラインで動作します。平面幾何は [`kataskeve.md`](kataskeve.md) を参照。

> **2D 版との違い（HTML エクスポート）** — 2D の出力はインライン SVG なのでそのままエクスポートに乗りますが、3D の出力は `<canvas>` のラスタです。canvas のピクセルは DOM の直列化に含まれないため、`X` キーの HTML 書き出しでは **PNG 画像に変換して埋め込みます**（自己完結は保たれ、CDN も参照しません）。PDF 出力と `--export-png` はライブ DOM を印刷／撮影するので変換は不要です。

## 1. 基本 — 視点と陰影

`view: tilt=<度> yaw=<度>` がカメラの俯角と方位（正射影）、`unit:` が 1 世界単位あたりの px です。`unit:` を明示すると自動フィットが切れて固定スケールになり、複数の図でサイズを揃えられます。

```kataskeve3d
view: tilt=22 yaw=0
unit: 90
shading: on
shading_density: 0.8
light: az=135 el=40
sphere(point(0,0,0), 2)
```

## 2. 多面体と陰線処理

`hidden_lines:` は隠れた稜線の扱いを選びます（`off` / `faint` / `dashed`）。

```kataskeve3d
view: tilt=26 yaw=32
unit: 90
hidden_lines: dashed
cube(point(0,0,0), 2)
```

## 3. クリッピング（`cut` / `cap`）

`cut(A, B)` は A の表面のうち B の内側を、`cut_out(A, B)` は外側を残します。`cap` は 2 番目の引数側を残す対称形です。平面で切った場合は既定で断面が塞がれ（`cut_fill: on`）、`open` トークンを付けると中空の薄い殻になって内壁が見えます。

```kataskeve3d
view: tilt=24 yaw=30
unit: 90
shading: on
shading_density: 0.7
T = torus(point(0,0,0), vector(0,0,1), 2, 0.7)
cut(T, plane(point(0,0,0), vector(1,1,0))) open
```

## 4. ヴィラルソー円 (Villarceau circles)

トーラスには、子午線・緯線のほかに**双接平面による斜めの円**が 2 族あります。`villarceau(T, family=…)` がその円を返し、`bitangent_plane(T, family=…)` が対応する双接平面を返します。

```kataskeve3d
view: tilt=26 yaw=35
unit: 90
T = torus(point(0,0,0), vector(0,0,1), 2, 0.7)
T
[c0, c1] = villarceau(T, family=0)
c0 color=#c0392b thick
c1 color=#2980b9 thick
```

双接平面そのもので切ると、切り口がまさにその 2 円になります。

```kataskeve3d
view: tilt=24 yaw=30
unit: 90
shading: on
shading_density: 0.7
T = torus(point(0,0,0), vector(0,0,1), 2, 0.7)
cut(T, bitangent_plane(T, family=0)) open
```

## 5. 開いたパラメトリック曲面

`hyperboloid` / `paraboloid` / `hyperbolic_paraboloid` / `flamm` / `spherical_harmonic` は閉じていない曲面で、シルエット輪郭として描かれます（自己遮蔽も正しく処理されます）。

```kataskeve3d
view: tilt=20 yaw=25
unit: 70
hidden_lines: faint
hyperbolic_paraboloid(point(0,0,0), vector(0,0,1), 1.6, 1.6, 2.2)
```

Flamm の放物面（Schwarzschild 埋め込み＝ワームホールの喉）：

```kataskeve3d
view: tilt=18 yaw=30
unit: 55
flamm(point(0,0,0), vector(0,0,1), 1, 3)
```

## 6. 不可能図形 — ペンローズの三角形

`penrose_triangle(中心, サイズ)` は 3 枚の L 字ピースが角で編み合う古典的な不可能図形です。常にカメラを向くので `view:` を変えても錯視が保たれ、`shading: on` では 3 枚がそれぞれ一様な別の階調になります。

このブロックは**紙（背景）の判定経路**も通ります — エンジンは祖先要素を遡って最初の不透明な背景色を「紙」として使うので、ライト／ダークどちらでも `M` キーで正しく塗り分かります。

```kataskeve3d
view: tilt=18 yaw=0
unit: 150
shading: on
light: az=150 el=35
penrose_triangle(point(0,0,0), 3)
```

## 7. 座標軸・ラベル・キャンバスサイズ

`axes: on` で原点を通る 3 軸、`label <点> "文字" pos=…` で注記を置けます。**`label` の対象は点でなければならず**、曲面や曲線に付けても描かれません。`width:` / `height:` はキャンバスの px サイズです（既定 680×460）。

```kataskeve3d
view: tilt=25 yaw=35
unit: 60
axes: on
width: 560
height: 400
O = point(0, 0, 0)
P = point(2, 1, 1.5)
S = sphere(O, 2.2)
S hidden=faint
segment(O, P) thick color=#c0392b
O; P
label O "O" pos=SW
label P "P(2, 1, 1.5)" pos=NE
```

## 8. 複合シーンとエラー表示

複数の切断を重ねると、入れ子のトーラス群のような密な図も描けます。`shading_fill: on` は面積の小さい切断パッチにも点描を行き渡らせます。

```kataskeve3d
view: tilt=24 yaw=12
shading: on
shading_density: 0.85
shading_gamma: 2.2
shading_fill: on
unit: 36
width: 440
height: 380
O = point(0,0,0)
A = vector(0,0,1)
T1 = torus(O, A, 1.118, 0.5)
T2 = torus(O, A, 2.236, 2)
T3 = torus(O, A, 5.496, 5.404)
T1
cut(T2, plane(point(0,-0.8,0), vector(-0.3,1,0))) open
cut(T3, sphere(O, 4.6))
```

構文エラーは図の位置に赤枠で表示され、同じ文書の他のブロックには影響しません。
