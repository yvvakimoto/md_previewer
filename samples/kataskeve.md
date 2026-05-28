# Kataskeve — 初等幾何作図ブロック

`kataskeve` フェンスは平面初等幾何（点・線分・直線・円・多角形・派生点・変換・角マーク）を式志向 DSL で記述し、SVG を埋め込みます。名称の `kataskeve` は古代ギリシア語 κατασκευή で、Euclid『原論』において命題の「作図段階」を指す術語に由来します。

## 1. 基本作図

```kataskeve
viewport: -1 -1 6 5
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

## 2. デフォルト三角形（SSS 指定／引数なし）

辺の長さ 3 つで「とりあえずの三角形」を 1 行で置けます。辺の対応は標準慣習 `a = |BC|`, `b = |CA|`, `c = |AB|`。

```kataskeve
viewport: -1 -1 7 5
T = triangle(5, 4, 3)
T
A = T.A; B = T.B; C = T.C
A; B; C
label A "A" pos=SW
label B "B" pos=SE
label C "C" pos=N
```

引数なしの `triangle()` は決め打ちのスカレーン三角形（`triangle(5, 4, 6)` と同じ）：

```kataskeve
viewport: -1 -1 8 5
T = triangle()
T
label T.A "A" pos=SW
label T.B "B" pos=SE
label T.C "C" pos=N
T.A; T.B; T.C
```

## 3. 派生点（中点・交点・垂足）

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

## 4. 円

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

## 5. 変換（回転・反射・平行移動）

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

## 6. 角マーク

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

## 7. 設定（grid / axes）

```kataskeve
viewport: -3 -2 3 3
grid: on
axes: on
O = point(0, 0)
P = point(2, 1.5)
O; P
segment(O, P)
label P "P(2, 1.5)" pos=NE
```

## 8. ★ 九点円 (nine-point circle) — 鋭角三角形

三角形の **3 辺の中点 / 3 垂線の足 / 3 オイラー点（垂心と各頂点の中点）** の 9 点が共有する単一の円が九点円です。`circle3(Ma, Mb, Mc)` で確定した円の上に、残り 6 点も乗っていることを目視で確認できます。

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

# 九点円（任意の 3 点で一意に決まる; 検証では中点 3 点を使用）
nine = circle3(Ma, Mb, Mc)
nine color=#c0392b thick

# 9 点を強調表示
Ma color=#c0392b
Mb color=#c0392b
Mc color=#c0392b
Ha color=#2980b9
Hb color=#2980b9
Hc color=#2980b9
Ea color=#27ae60
Eb color=#27ae60
Ec color=#27ae60
H color=#7f8c8d
label H "H" pos=NE
```

### 同じ三角形で「垂線の足 3 点」から決めた円と比較

`circle3(Ha, Hb, Hc)` で別に求めた円が中点 3 点版と完全一致することを目視確認。

```kataskeve
viewport: -1 -1 7 6
unit: 60

A = point(0, 0); B = point(6, 0); C = point(1.5, 4.5)
triangle(A, B, C)

Mc = midpoint(A, B); Ma = midpoint(B, C); Mb = midpoint(C, A)
Ha = foot(A, B, C); Hb = foot(B, C, A); Hc = foot(C, A, B)

# 中点 3 点で確定した九点円
c1 = circle3(Ma, Mb, Mc)
c1 color=#c0392b thick

# 垂線の足 3 点で確定した円（破線で重ね、完全一致するはず）
c2 = circle3(Ha, Hb, Hc)
c2 color=#16a085 dashed thick

Ma color=#c0392b; Mb color=#c0392b; Mc color=#c0392b
Ha color=#2980b9; Hb color=#2980b9; Hc color=#2980b9
A; B; C
```

### 鈍角三角形のケース（垂線の足が辺の外に出る）

角 B が鈍角となる配置でも 9 点はすべて九点円上にあります。

```kataskeve
viewport: -2 -3 8 5
unit: 50

A = point(0, 0)
B = point(5, 0)
C = point(7, 3)

triangle(A, B, C)
A; B; C
label A "A" pos=SW
label B "B" pos=S
label C "C" pos=NE

Mc = midpoint(A, B); Ma = midpoint(B, C); Mb = midpoint(C, A)
Ha = foot(A, B, C); Hb = foot(B, C, A); Hc = foot(C, A, B)
H = orthocenter(A, B, C)
Ea = midpoint(H, A); Eb = midpoint(H, B); Ec = midpoint(H, C)

segment(A, Ha) dashed thin
segment(B, Hb) dashed thin
segment(C, Hc) dashed thin

nine = circle3(Ma, Mb, Mc)
nine color=#c0392b thick

Ma color=#c0392b; Mb color=#c0392b; Mc color=#c0392b
Ha color=#2980b9; Hb color=#2980b9; Hc color=#2980b9
Ea color=#27ae60; Eb color=#27ae60; Ec color=#27ae60
H color=#7f8c8d
label H "H" pos=NE
```

## 9. ★ パスカルの定理 (Pascal's theorem)

円錐曲線（ここでは円）に内接する六角形 P1‑P2‑P3‑P4‑P5‑P6 の対辺 3 組（P1P2 と P4P5 / P2P3 と P5P6 / P3P4 と P6P1）を延長した直線どうしの交点 X, Y, Z は、必ず同一直線（**パスカル線**）上に並びます。

[Pascal's theorem](https://en.wikipedia.org/wiki/Pascal%27s_theorem) の代表的な 2 つの図を参考に、(a) 単純凸六角形のケースと (b) 自己交差六角形（mystic hexagram）のケースを 1 つずつ示します。`viewport` を明示せず自動 bbox に任せることで、3 つの交点 X, Y, Z と円本体の双方を必ず画角に収めます。

### (a) 単純凸六角形のケース

円周上に巡回順に並べた 6 点を辺で順に結ぶと凸六角形になります。対辺どうしは凸性ゆえに「ほぼ平行」となり、交点 X, Y, Z は円から離れた位置に大きく散ります。それでも 3 点は完全に共線で、パスカル線（赤）の上に乗ります。

```kataskeve
unit: 30

O = point(0, 0)
C = circle(O, 1)
C color=#7f8c8d
O

P1 = point_on(C,  20)
P2 = point_on(C,  85)
P3 = point_on(C, 170)
P4 = point_on(C, 200)
P5 = point_on(C, 250)
P6 = point_on(C, 315)

# 凸六角形の辺
segment(P1, P2)
segment(P2, P3)
segment(P3, P4)
segment(P4, P5)
segment(P5, P6)
segment(P6, P1)

P1; P2; P3; P4; P5; P6
label P1 "P1" pos=E
label P2 "P2" pos=N
label P3 "P3" pos=W
label P4 "P4" pos=SW
label P5 "P5" pos=S
label P6 "P6" pos=SE

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
label X "X" pos=NE
label Y "Y" pos=NE
label Z "Z" pos=SE

# パスカル線：X と Z を結ぶ赤い直線が Y も通る
line(X, Z) color=#c0392b thick
```

### (b) 自己交差六角形（mystic hexagram）のケース

同じ円周上の 6 点でも、ラベル順 P1..P6 が円を 2 周するように非巡回順で結ぶと、六角形は自己交差して「神秘の六角形 (mystic hexagram)」になります。対辺どうしの角度差が大きく、3 つの交点は円の内部または近傍にコンパクトに収まります。

```kataskeve
unit: 50

O = point(0, 0)
C = circle(O, 2)
C color=#7f8c8d
O

# 円周上の 6 点を非巡回順に配置（ラベル順で 1 周＋αするように）
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

# 対辺ペアの延長
line(P1, P2) dashed thin color=#bdc3c7
line(P4, P5) dashed thin color=#bdc3c7
line(P2, P3) dashed thin color=#bdc3c7
line(P5, P6) dashed thin color=#bdc3c7
line(P3, P4) dashed thin color=#bdc3c7
line(P6, P1) dashed thin color=#bdc3c7

# 3 つの対辺交点（このケースでは円の内部寄りに揃う）
X = intersection(line(P1, P2), line(P4, P5))
Y = intersection(line(P2, P3), line(P5, P6))
Z = intersection(line(P3, P4), line(P6, P1))

X color=#c0392b
Y color=#c0392b
Z color=#c0392b
label X "X" pos=SE
label Y "Y" pos=NW
label Z "Z" pos=E

# パスカル線
line(X, Z) color=#c0392b thick
```
