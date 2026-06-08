# 動画 / YouTube 埋め込み

画像記法 `![alt](パス)` をそのまま流用して、ローカル動画ファイルと YouTube 動画を
埋め込める。一般文書でも Marp スライドでも同じ記法で動作する。

- ローカル動画 (`.mov` / `.mp4` / `.m4v` / `.webm` / `.ogv` / `.ogg`) → `<video controls>`
- YouTube URL (`youtu.be` / `youtube.com/watch` / `embed` / `shorts`) → レスポンシブ `<iframe>`

> 補足: ローカル動画は base64 埋め込みされず、内部の `app://localhost/userfile/` ルート
> 経由で配信される。HTTP Range に対応しているのでシーク (早送り / 巻き戻し) が効く。
> `.mov` は H.264 コーデックなら WebView2 (Chromium) で再生できるが、ProRes / HEVC 等は
> 再生できないことがある（その場合は `.mp4` 等に変換する）。

## 1. ローカル動画

このファイルと同じ場所に動画を置いて相対パスで参照する（下の例は `videos/sample.mp4` を想定）。

```markdown
![デモ動画](videos/sample.mp4)
```

![デモ動画](videos/sample.mp4)

## 2. サイズ指定

画像と同じ `|幅` / `|幅x高さ` 接尾辞でピクセルサイズを指定できる（`@scale` は動画では非対応）。

```markdown
![480px幅](videos/sample.mp4|480)
![640x360](videos/sample.mp4|640x360)
```

## 3. YouTube

```markdown
![](https://www.youtube.com/watch?v=dQw4w9WgXcQ)
![短縮URL](https://youtu.be/dQw4w9WgXcQ)
![開始位置=90秒](https://youtu.be/dQw4w9WgXcQ?t=90)
![幅指定](https://youtu.be/dQw4w9WgXcQ|560)
```

![](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

開始位置は `?t=90` / `?t=1m30s` / `?start=90` のいずれの書式でも解釈する。
サイズ未指定の YouTube は 16:9 でコンテナ幅に追従する。

## エクスポート (`X` キー)

- ローカル動画は出力先に `media/` フォルダを作ってコピーし、相対パスで参照する。
- YouTube は `https` URL のままなのでエクスポート HTML でもそのまま再生できる（要ネットワーク）。
