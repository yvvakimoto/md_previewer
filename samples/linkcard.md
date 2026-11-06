# リンクカード（`linkcard` フェンス）

`linkcard` フェンスに URL を書くと、ページのタイトル・説明・サムネイル（OGP）を
カードとして表示します。情報はアプリが取得してキャッシュするので、一度表示した
カードはオフラインでも同じように出ます。

## URL だけ書く

```linkcard
https://github.com/
```

## 手書きの値で上書きする

`title:` / `description:` / `image:` / `site:` を書くと、取得した値より優先されます。
`image:` にはローカルの画像も使えます。

```linkcard
https://www.markdownguide.org/
title: Markdown Guide（手書きのタイトル）
description: 取得した説明文の代わりにこの文が出ます。
image: images/test.png
```

## 取得しない（`fetch: false`）

ネットワークに一切触れず、手書きの値だけでカードにします。

```linkcard
https://example.com/internal/wiki
title: 社内 Wiki のトップ
description: 社外からは見えないページなど、取得できない URL に。
site: 社内 Wiki
fetch: false
```

## `http://` の URL

取得するのは `https://` だけです。`http://` は URL とドメインだけのカードになります。

```linkcard
http://example.com/
```

---

- 取得は S キーのスタイル設定で OFF にできます（OFF のときはキャッシュ済みの情報だけを使います）。
- 取得に失敗したときや、待ち時間（6 秒）を超えたときも、URL だけのカードで表示を続けます。
