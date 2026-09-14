# 3D モデル表示（model3d）

`model3d` フェンスに **3D メッシュファイルへのパス**を書くと、同梱の
[three.js](https://threejs.org/)（MIT）でその形状をプレビュー内に直接描画します。
**マウスドラッグで回転、ホイールでズーム**できます。
ダーク/ライト表示・HTML エクスポート・Marp スライドにそのまま対応し、
ライブラリは同梱なので **完全オフライン**（初回だけ遅延ロード）。

対応形式は **STL**（バイナリ／ASCII 両対応）・**OBJ**・**PLY**・**glTF**・**GLB**・**3MF**。
CAD からメッシュに書き出したデータや、3D プリンタ用の STL をそのまま貼れます。

> **HTML エクスポートについて** — 出力は `<canvas>` のラスタです。canvas のピクセルは
> DOM の直列化に含まれないため、`X` キーの HTML 書き出しでは **PNG 画像に変換して
> 埋め込みます**（自己完結は保たれ、CDN も参照しません）。回転・ズームは
> プレビュー内だけの機能で、書き出した HTML では静止画になります。
> PDF 出力と `--export-png` はライブ DOM を印刷／撮影するので変換は不要です。

## 基本

`file:` にマークダウンからの相対パスを書きます。`../` で上位フォルダも辿れます。

```model3d
file: data/bracket.stl
```

## 最短形

設定が要らないときは、**パスだけ**を 1 行書けば済みます。

```model3d
data/bracket.stl
```

## 表示オプション

`edges:` はエッジ線を重ねます。機械部品の稜線がはっきりするので CAD 形状で有効です。
`grid:` は床グリッド、`axes:` は座標軸（X=赤・Y=緑・Z=青）を追加します。

```model3d
file: data/bracket.stl
color: "#7fb069"
edges: true
grid: true
axes: true
height: 380
```

`wireframe: true` にすると面を塗らずワイヤーフレーム表示になります。

```model3d
file: data/bracket.stl
wireframe: true
color: "#d19a66"
width: 420
height: 300
```

## カメラの初期位置

`camera:` で初期視点を指定します。`azimuth`（方位角・度）、`elevation`（仰角・度）、
`distance`（形状の外接球半径に対する倍率）。省略時は形状全体が収まるよう自動調整。

```model3d
file: data/bracket.stl
camera:
  azimuth: -60
  elevation: 55
  distance: 2.6
edges: true
```

## OBJ

OBJ はマテリアルファイルを `mtl:` で指定できます。省略した場合は `color:` が使われます。

```model3d
file: data/bracket.obj
color: "#c678dd"
height: 320
```

## 指定できるキー

| キー | 既定 | 内容 |
|---|---|---|
| `file` | （必須） | モデルへの相対パス／絶対パス |
| `format` | 拡張子から自動判定 | `stl` / `obj` / `ply` / `gltf` / `glb` / `3mf` |
| `width` / `height` | `680` / `460` | 表示サイズ（px） |
| `color` | テーマ由来 | メッシュの色（ファイル自身がマテリアルを持つ場合はそちらが優先） |
| `background` | 透明 | 背景色 |
| `edges` / `wireframe` | `false` | エッジ線／ワイヤーフレーム |
| `grid` / `axes` | `false` | 床グリッド／座標軸 |
| `camera` | 自動 | `azimuth` / `elevation` / `distance` |
| `mtl` | なし | OBJ 用マテリアルファイル |

モデルファイルを保存し直すとプレビューも自動で追従します
（`../` を含むパスのときは追従しません）。

## エラー時の挙動

不正な指定は他の図に影響を与えず、その場に赤枠のエラーとして表示されます。

存在しないファイル:

```model3d
file: data/no-such-model.stl
```

未対応の形式:

```model3d
file: data/sales.csv
```

`file:` の指定漏れ:

```model3d
color: "#ff0000"
```

## 既知の制限

- **圧縮された glTF（Draco / KTX2）には未対応**です。デコーダが実行時に別アセットを
  取得する必要があり、オフライン同梱の方針と噛み合わないためです。非圧縮で書き出してください。
- アニメーション付き glTF は**静止表示**のみ（アニメーションは再生されません）。
- モデルは 64 MB までです。
- STEP / IGES などのソリッド CAD 形式は対象外です。CAD 側でメッシュ
  （STL / OBJ / glTF）に書き出してから貼ってください。
