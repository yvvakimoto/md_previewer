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

画像と同じ **alt テキストの `|幅` / `|幅x高さ` 接尾辞**でピクセルサイズを指定できる（`@scale` は動画では非対応）。接尾辞は URL 側ではなく `]` の前（alt 内）に置くこと。

```markdown
![480px幅|480](videos/sample.mp4)
![|640x360](videos/sample.mp4)
```

Marp スライドでは、Marp ネイティブの画像ディレクティブ `![w:400](clip.mp4)` / `![w:400 h:225](clip.mp4)`（`width:` / `height:` も可）でも動画・YouTube のサイズを指定できる。

## 3. YouTube

```markdown
![](https://www.youtube.com/watch?v=dQw4w9WgXcQ)
![短縮URL](https://youtu.be/dQw4w9WgXcQ)
![開始位置=90秒](https://youtu.be/dQw4w9WgXcQ?t=90)
![幅指定|560](https://youtu.be/dQw4w9WgXcQ)
```

![](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

開始位置は `?t=90` / `?t=1m30s` / `?start=90` のいずれの書式でも解釈する。
サイズ未指定の YouTube は 16:9 でコンテナ幅に追従する。

## 4. PDF 用フレーム時刻指定 (`t=`)

PDF はページ内で動画を再生できないため、**PDF 出力時 (`X` → `.pdf`) はローカル動画をその場で
静止画に差し替える**。どの瞬間のフレームを使うかは、alt テキストの **`|t=<時刻>`** トークンで
`.md` に直接記述できる（サイズ接尾辞 `|幅` / `|幅x高さ` と順不同で併記可）。

```markdown
![説明|t=3](videos/sample.mp4)          # 3秒地点のフレームをPDFに
![説明|480|t=1m30s](videos/sample.mp4)  # 幅480px + 90秒地点
![|t=0:05|640x360](videos/sample.mp4)   # 順不同OK
```

時刻の書式: `3` / `2.5`（秒・小数可）/ `90s` / `1m30s` / `1h2m3s` / `0:03`（分:秒）/ `1:02:03`（時:分:秒）。

- 指定すると**プレビューでもその位置のフレームが静止表示**されるので、狙った瞬間かを目視確認できる（再生は従来どおり可能）。
- `t=` を書かなかった動画は、PDF 出力時点の**現在の再生位置**（既定は先頭）のフレームを自動で使う。
- `t=` は**ローカル動画専用**。YouTube はクロスオリジンでフレーム取得できないため対象外（開始位置は URL の `?t=` を使う）。
- 反映は **PDF 出力のみ**。プレビュー表示と HTML エクスポートは従来どおり再生可能な `<video>` のまま。

## エクスポート (`X` キー)

- ローカル動画は HTML 出力先に `media/` フォルダを作ってコピーし、相対パスで参照する。
- PDF 出力では動画は上記のとおり静止画フレームに差し替わる（`media/` へのコピーは行われない）。
- YouTube は `https` URL のままなのでエクスポート HTML でもそのまま再生できる（要ネットワーク）。
