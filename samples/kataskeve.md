# Kataskeve — 平面初等幾何の作図ブロック

`kataskeve` フェンスは平面初等幾何（点・線分・直線・円・多角形・派生点・変換・角マーク）を式志向 DSL で記述し、インライン SVG として埋め込みます。名称は古代ギリシア語 κατασκευή で、Euclid『原論』において命題の「作図段階」を指す術語に由来します。

エンジンは外部パッケージ [kataskeve](https://github.com/yvvakimoto/kataskeve)（MIT）を同梱したもので、依存ゼロ・完全オフラインで動作します。出力はインライン SVG なので HTML エクスポートにもそのまま乗ります。3D 版は [`kataskeve3d.md`](kataskeve3d.md) を参照。

## 1. 基本作図（grid / axes 付き）

`viewport` で画角、`unit` で 1 世界単位あたりの px、`grid: on` / `axes: on` で方眼と座標軸を出します。方眼と軸の色だけはダーク／ライトで塗り分けられます（`M` キーで確認できます）。

```kataskeve
viewport: -1 -1 6 5
grid: on
axes: on
A = point(0, 0)
B = point(5, 0)
C = point(2, 4)
triangle(A, B, C)
A; B; C
label A "A" pos=SW
label B "B" pos=SE
label C "C" pos=N
mark tick(segment(A, B)) count=1
mark tick(segment(B, C)) count=2
mark tick(segment(C, A)) count=3
```

## 2. 三角形の略記（SSS 指定・引数なし）

辺の長さ 3 つで「とりあえずの三角形」を 1 行で置けます。辺の対応は標準慣習 `a = |BC|`, `b = |CA|`, `c = |AB|`。引数なしの `triangle()` は決め打ちのスカレーン三角形（`triangle(5, 4, 6)` と同じ）になります。`T.A` / `T.B` / `T.C` で頂点を、`T.AB` などで辺を取り出せます。

```kataskeve
viewport: -1 -1 7 5
T = triangle(5, 4, 3)
T
label T.A "A" pos=SW
label T.B "B" pos=SE
label T.C "C" pos=N
T.A; T.B; T.C
G = centroid(T.A, T.B, T.C)
G color=#c0392b
label G "重心 G" pos=NE
```

## 3. 派生点（中点・垂足・交点）

```kataskeve
viewport: -1 -1 7 5
A = point(0, 0); B = point(6, 0); C = point(1.5, 4)
triangle(A, B, C)
M = midpoint(A, B)
H = foot(C, A, B)
I = intersection(line(A, C), line(B, point(3, 4)))
A; B; C
M color=#c0392b
H color=#2980b9
I color=#27ae60
label M "中点" pos=S
label H "垂足" pos=S
label I "交点" pos=NE
segment(C, H) dashed thin
```

## 4. 円と円周上の点

`circle(中心, 半径)` のほか、3 点を通る円 `circle3`、直径指定の `circle_diameter`、円周上の角度指定 `point_on(円, 度)` があります。

```kataskeve
viewport: -3 -3 3 3
O = point(0, 0)
C = circle(O, 2)
C
O
P = point_on(C, 30)
Q = point_on(C, 150)
R = point_on(C, 270)
P; Q; R
label P "30°" pos=NE
label Q "150°" pos=NW
label R "270°" pos=S
triangle(P, Q, R)
```

## 5. 変換（平行移動・回転・反射）

```kataskeve
viewport: -4 -3 6 4
A = point(0, 0); B = point(3, 0); C = point(1, 2)
T = polygon(A, B, C)
T color=#7f8c8d
# 平行移動
T2 = translate(T, vector(0.3, 2))
T2 color=#2980b9
# 中心 A を軸に 60° 回転
T3 = rotate(T, A, 60)
T3 color=#c0392b
# y = 0 直線で対称
L = line(point(-3, 0), point(5, 0))
T4 = reflect(T, L)
T4 color=#27ae60 dashed
label A "A" pos=SW
```

## 6. 角マーク・等長マーク

`mark right_angle(P,Q,R)` は直角記号、`mark angle(P,Q,R) arcs=n` は円弧 n 本、`mark tick(辺) count=n` は等長を表す斜線 n 本を描きます。

```kataskeve
viewport: -1 -1 5 4
A = point(0, 0); B = point(4, 0); C = point(4, 3)
triangle(A, B, C)
A; B; C
label A "A" pos=SW
label B "B" pos=SE
label C "C" pos=NE
mark right_angle(A, B, C)
mark angle(B, A, C) arcs=1 radius=0.8
mark angle(B, C, A) arcs=2 radius=0.6
```

## 7. 内接円

`foot(点, 直線)` と `distance` を組み合わせると、内心から辺への距離＝内接円の半径が求まります。

```kataskeve
grid: on
axes: on
unit: 60
A = point(0, 0)
B = point(4, 0)
C = point(0, 3)
polygon(A, B, C)
I = incenter(A, B, C)
circle(I, distance(I, foot(I, line(A, B)))) color=#2980b9
mark right_angle(B, A, C)
mark tick(segment(A, C)) count=1
mark angle(A, B, C) arcs=2
I color=#2980b9
label I "内心 I" pos=NE
```

## 8. 九点円 (nine-point circle)

三角形の **3 辺の中点 / 3 垂線の足 / 3 オイラー点（垂心と各頂点の中点）** の 9 点は 1 つの円を共有します。`circle3(Ma, Mb, Mc)` を中点 3 点だけから確定させると、残り 6 点もその円に乗ることが目視で確認できます。

```kataskeve
viewport: -1 -1 7 6
unit: 60

A = point(0, 0)
B = point(6, 0)
C = point(1.5, 4.5)

triangle(A, B, C)
A; B; C
label A "A" pos=SW
label B "B" pos=SE
label C "C" pos=N

# 3 辺の中点
Mc = midpoint(A, B)
Ma = midpoint(B, C)
Mb = midpoint(C, A)

# 3 垂線の足
Ha = foot(A, B, C)
Hb = foot(B, C, A)
Hc = foot(C, A, B)

# 垂心と 3 つのオイラー点
H = orthocenter(A, B, C)
Ea = midpoint(H, A)
Eb = midpoint(H, B)
Ec = midpoint(H, C)

# 3 つの高さ（補助線）
segment(A, Ha) dashed thin
segment(B, Hb) dashed thin
segment(C, Hc) dashed thin

# 九点円（中点 3 点のみから確定）
nine = circle3(Ma, Mb, Mc)
nine color=#c0392b thick

Ma color=#c0392b; Mb color=#c0392b; Mc color=#c0392b
Ha color=#2980b9; Hb color=#2980b9; Hc color=#2980b9
Ea color=#27ae60; Eb color=#27ae60; Ec color=#27ae60
H color=#7f8c8d
label H "H" pos=NE
```

## 9. パスカルの定理 (Pascal's theorem)

円錐曲線（ここでは円）に内接する六角形 P1‑P2‑P3‑P4‑P5‑P6 の対辺 3 組を延長した直線どうしの交点 X, Y, Z は、必ず同一直線（**パスカル線**）上に並びます。ここではラベル順が円を 2 周する自己交差六角形（mystic hexagram）で示します。`viewport` を書かず自動 bbox に任せると、交点 X, Y, Z と円本体の双方が必ず画角に収まります。

```kataskeve
unit: 50

O = point(0, 0)
C = circle(O, 2)
C color=#7f8c8d
O

# 円周上の 6 点を非巡回順に配置
P1 = point_on(C,  18)
P2 = point_on(C, 205)
P3 = point_on(C,  82)
P4 = point_on(C, 298)
P5 = point_on(C, 143)
P6 = point_on(C, 340)

# 自己交差する六角形の辺
segment(P1, P2)
segment(P2, P3)
segment(P3, P4)
segment(P4, P5)
segment(P5, P6)
segment(P6, P1)

P1; P2; P3; P4; P5; P6
label P1 "P1" pos=NE
label P2 "P2" pos=SW
label P3 "P3" pos=N
label P4 "P4" pos=SE
label P5 "P5" pos=NW
label P6 "P6" pos=E

# 対辺ペアの延長（無限直線 → viewport の縁まで伸びる）
line(P1, P2) dashed thin color=#bdc3c7
line(P4, P5) dashed thin color=#bdc3c7
line(P2, P3) dashed thin color=#bdc3c7
line(P5, P6) dashed thin color=#bdc3c7
line(P3, P4) dashed thin color=#bdc3c7
line(P6, P1) dashed thin color=#bdc3c7

# 3 つの対辺交点
X = intersection(line(P1, P2), line(P4, P5))
Y = intersection(line(P2, P3), line(P5, P6))
Z = intersection(line(P3, P4), line(P6, P1))

X color=#c0392b
Y color=#c0392b
Z color=#c0392b
label X "X" pos=SE
label Y "Y" pos=NW
label Z "Z" pos=E

# パスカル線：X と Z を結ぶ赤い直線が Y も通る
line(X, Z) color=#c0392b thick
```

## 10. スタイルトークンとエラー表示

各描画コマンドの末尾に `color=` / `fill=` / `thickness=` / `thick` / `thin` / `dashed` / `dotted` / `hidden` を並べられます。`#` は行コメントですが、直後が 16 進数字なら色リテラル（`#c0392b`）として扱われます。

構文エラーは図の位置に赤枠で表示され、同じ文書の他のブロックには影響しません。

```kataskeve
viewport: -1 -1 5 4
A = point(0, 0); B = point(4, 0)
segment(A, B) thick color=#8e44ad
segment(A, point(2, 3)) dashed
segment(B, point(2, 3)) dotted thickness=2.5
polygon(A, B, point(2, 3)) fill=#f1c40f55
A; B
```
