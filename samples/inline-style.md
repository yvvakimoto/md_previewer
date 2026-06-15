# インラインスタイル（文字色・サイズ・フォント）

文の一部分だけ色・大きさ・書体を変えたいときは、Pandoc 風の
インライン記法 `[テキスト]{属性 …}` を使います。`]` の直後に
空白を空けず `{` を続け、`空白区切りの key=value` で指定します。

| キー | 短縮 | 効果 | 値の例 |
|------|------|------|--------|
| `color` | `c` | 文字色 | `red` / `#e91e63` / `rgb(0,128,0)` |
| `bg` | `background` | 背景色 | `yellow` / `#fff3cd` |
| `size` | `s` | 文字サイズ | `small` / `large` / `xxl` / `1.4em` / `120%` |
| `font` | `f` | フォント | `serif` / `sans` / `mono` / 任意のフォント名 |
| `weight` | `w` | 文字の太さ | `bold` / `light` / `600` |
| `valign` | `v` | 縦位置（ベースライン） | `middle` / `bottom` / `top` |

認識できる属性が 1 つも無い場合は何も変換されないので、通常の
リンク `[ラベル](url)` や参照 `[ラベル][id]` とは衝突しません。

---

## 1. 文字色

ここは普通の文、ここだけ[赤い文字]{color=red}になります。
[ピンク背景]{bg=#fff3cd}や[16進指定]{color=#0a7d33}も使えます。

## 2. 文字サイズ

キーワード指定: [極小]{size=xs} / [小]{size=small} / 標準 /
[大]{size=large} / [特大]{size=xxl}。

実値指定: [1.4em]{size=1.4em} / [120%]{size=120%} も可能です。

## 3. フォント

本文サンセリフの中で[これは明朝体（serif）]{font=serif}、
[これは等幅（mono）]{font=mono}、
[任意のフォント名]{font="Comic Sans MS"}も指定できます。

## 4. 太さ

[細字]{weight=light}・標準・[太字]{weight=bold}・[数値600]{weight=600}。

## 5. ベースライン揃え（valign）

大きい文字と小さい文字を混ぜたときの縦位置を揃えられます。

- 既定（baseline）: 大[小さい添え]{size=small}文字
- 中央揃え: 大[中央の小文字]{size=small valign=middle}文字
- 下揃え: 大[下の小文字]{size=small valign=bottom}文字

## 6. 属性の組み合わせと入れ子

複数属性をまとめて: [重要・赤・大・太]{color=red size=large weight=bold}。

中身には Markdown を入れ子にできます:
[**太字**と`コード`を含む青字]{color=navy}。

> 補足: コードスパン内の `` `[x]{c=red}` `` はそのまま表示され、変換されません。
