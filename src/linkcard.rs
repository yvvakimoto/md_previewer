//! ```` ```linkcard ```` metadata: fetch a page's OGP card fields, cache them on
//! disk, and hand the preview a small JSON record.
//!
//! The preview asks with the `linkcard:` IPC (`src/main.rs`); a worker thread
//! calls [`resolve`] and posts `CustomEvent::LinkCardDone`, which becomes
//! `window.__linkCardDone(url, meta)` in `assets/index.html`. The card image is
//! downloaded here too and served back from disk by the `/linkcard-img/<key>`
//! route, so the page never hotlinks a third-party image (no Referer / IP leak,
//! and the card keeps its thumbnail offline once cached).
//!
//! Design notes (detail in `.claude/docs/preview-blocks.md`, *Link cards*):
//! - HTTPS only — `http_win` refuses plaintext, and an `http://` card simply
//!   falls back to the URL-only card in the preview.
//! - Failures are never written to disk: a page that was down yesterday must get
//!   another chance today. The preview remembers them for the session instead.
//! - The cache lives under `%TEMP%\mdp-linkcard\`, the updater's convention.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Overall wall-clock ceiling for fetching the page HTML.
pub const PAGE_TIMEOUT_MS: u64 = 5_000;
/// Overall wall-clock ceiling for downloading the card image.
pub const IMAGE_TIMEOUT_MS: u64 = 8_000;
/// Only the head of the page is needed; a larger body is truncated, not refused.
pub const PAGE_MAX_BYTES: usize = 1024 * 1024;
/// A card thumbnail larger than this is dropped (the card keeps its text).
pub const IMAGE_MAX_BYTES: u64 = 5 * 1024 * 1024;
/// A cached record older than this is refetched (when fetching is allowed).
pub const CACHE_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);

const TITLE_MAX_CHARS: usize = 200;
const DESC_MAX_CHARS: usize = 300;
const SITE_MAX_CHARS: usize = 80;

/// The record handed to the preview. `img` is an app-relative route
/// (`/linkcard-img/<key>`) or empty — never a remote URL.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Meta {
    pub ok: bool,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub desc: String,
    #[serde(default)]
    pub site: String,
    #[serde(default)]
    pub img: String,
}

impl Meta {
    fn fail() -> Self {
        Meta::default()
    }
}

/// What [`parse_og`] found in the HTML. `image` is an absolute URL (or empty).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Og {
    pub title: String,
    pub desc: String,
    pub site: String,
    pub image: String,
}

pub fn cache_dir() -> PathBuf {
    std::env::temp_dir().join("mdp-linkcard")
}

/// Stable 16-hex-digit cache key (FNV-1a 64). Hand-written on purpose: std's
/// `DefaultHasher` is not guaranteed stable across Rust releases, and the key
/// names files that outlive the process.
pub fn cache_key(url: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in url.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{:016x}", h)
}

/// The `/linkcard-img/` route accepts exactly a [`cache_key`] — never a path.
pub fn is_valid_key(s: &str) -> bool {
    s.len() == 16 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn image_path(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{}.img", key))
}

fn json_path(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{}.json", key))
}

/// Sniff an image MIME type from its first bytes; `None` = not an image we serve.
pub fn sniff_image_mime(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("image/png")
    } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if b.starts_with(b"GIF8") {
        Some("image/gif")
    } else if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// Resolve the card for `url`. With `cache_only` the network is never touched
/// (the preview's fetch toggle is OFF): a cached record of any age is returned,
/// otherwise a failure.
pub fn resolve(url: &str, cache_only: bool) -> Meta {
    let url = url.trim();
    if !url.to_ascii_lowercase().starts_with("https://") {
        return Meta::fail();
    }
    let dir = cache_dir();
    let key = cache_key(url);

    if let Some((meta, fresh)) = read_cache(&dir, &key) {
        if fresh || cache_only {
            return meta;
        }
    }
    if cache_only {
        return Meta::fail();
    }

    let fetch_url = url.to_string();
    let html = match crate::updater::run_with_timeout(PAGE_TIMEOUT_MS, move || {
        fetch_page(&fetch_url)
    }) {
        Some(Ok(bytes)) => decode_html(&bytes),
        Some(Err(e)) => {
            crate::dbg_log_write(&format!("linkcard: fetch failed {}: {}", url, e));
            return Meta::fail();
        }
        None => {
            crate::dbg_log_write(&format!("linkcard: fetch timed out {}", url));
            return Meta::fail();
        }
    };

    let og = parse_og(&html, url);
    if og.title.is_empty() && og.desc.is_empty() {
        return Meta::fail();
    }

    let _ = std::fs::create_dir_all(&dir);
    let mut meta = Meta {
        ok: true,
        title: og.title,
        desc: og.desc,
        site: og.site,
        img: String::new(),
    };
    if !og.image.is_empty() && download_image(&og.image, &dir, &key) {
        meta.img = format!("/linkcard-img/{}", key);
    }
    if let Ok(s) = serde_json::to_string(&meta) {
        let _ = std::fs::write(json_path(&dir, &key), s);
    }
    meta
}

/// `(record, still within the TTL)`.
fn read_cache(dir: &Path, key: &str) -> Option<(Meta, bool)> {
    let p = json_path(dir, key);
    let text = std::fs::read_to_string(&p).ok()?;
    let mut meta: Meta = serde_json::from_str(&text).ok()?;
    if !meta.ok {
        return None;
    }
    // A record whose image has since been cleaned out of %TEMP% keeps its text.
    if !meta.img.is_empty() && !image_path(dir, key).is_file() {
        meta.img.clear();
    }
    let fresh = std::fs::metadata(&p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .map(|age| age < CACHE_TTL)
        .unwrap_or(false);
    Some((meta, fresh))
}

#[cfg(windows)]
fn fetch_page(url: &str) -> std::io::Result<Vec<u8>> {
    crate::http_win::get_truncated(
        url,
        "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        PAGE_TIMEOUT_MS,
        PAGE_MAX_BYTES,
    )
}

#[cfg(not(windows))]
fn fetch_page(_url: &str) -> std::io::Result<Vec<u8>> {
    Err(std::io::Error::other("linkcard fetch is Windows-only"))
}

/// Download `img_url` to `<key>.img`, keeping it only if it sniffs as an image.
fn download_image(img_url: &str, dir: &Path, key: &str) -> bool {
    if !img_url.to_ascii_lowercase().starts_with("https://") {
        return false;
    }
    let part = dir.join(format!("{}.part", key));
    let dest = image_path(dir, key);
    let (u, p) = (img_url.to_string(), part.clone());
    let got = crate::updater::run_with_timeout(IMAGE_TIMEOUT_MS, move || fetch_image(&u, &p));
    let ok = matches!(got, Some(Ok(_)))
        && std::fs::read(&part)
            .ok()
            .map(|b| sniff_image_mime(&b).is_some())
            .unwrap_or(false);
    if ok && std::fs::rename(&part, &dest).is_ok() {
        return true;
    }
    let _ = std::fs::remove_file(&part);
    false
}

#[cfg(windows)]
fn fetch_image(url: &str, dest: &Path) -> std::io::Result<u64> {
    crate::http_win::download(url, dest, IMAGE_TIMEOUT_MS, IMAGE_MAX_BYTES)
}

#[cfg(not(windows))]
fn fetch_image(_url: &str, _dest: &Path) -> std::io::Result<u64> {
    Err(std::io::Error::other("linkcard fetch is Windows-only"))
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/// The Windows code page a declared `charset` maps to, for the encodings a
/// Japanese user will actually meet. `None` = treat as UTF-8.
pub fn charset_codepage(html_head: &[u8]) -> Option<u32> {
    let n = html_head.len().min(4096);
    let head = String::from_utf8_lossy(&html_head[..n]).to_ascii_lowercase();
    let re = regex::Regex::new(r#"charset\s*=\s*["']?\s*([a-z0-9_\-]+)"#).ok()?;
    let cs = re.captures(&head)?.get(1)?.as_str().to_string();
    match cs.as_str() {
        "shift_jis" | "shift-jis" | "sjis" | "x-sjis" | "windows-31j" | "cp932" | "ms932" | "ms_kanji" => Some(932),
        "euc-jp" | "x-euc-jp" | "eucjp" => Some(20932),
        _ => None,
    }
}

pub fn decode_html(bytes: &[u8]) -> String {
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if let Some(cp) = charset_codepage(body) {
        if let Some(s) = decode_codepage(body, cp) {
            return s;
        }
    }
    String::from_utf8_lossy(body).into_owned()
}

#[cfg(windows)]
fn decode_codepage(bytes: &[u8], cp: u32) -> Option<String> {
    use windows::Win32::Globalization::{MultiByteToWideChar, MULTI_BYTE_TO_WIDE_CHAR_FLAGS};
    if bytes.is_empty() {
        return Some(String::new());
    }
    let flags = MULTI_BYTE_TO_WIDE_CHAR_FLAGS(0);
    let need = unsafe { MultiByteToWideChar(cp, flags, bytes, &mut []) };
    if need <= 0 {
        return None;
    }
    let mut buf = vec![0u16; need as usize];
    let got = unsafe { MultiByteToWideChar(cp, flags, bytes, &mut buf) };
    if got <= 0 {
        return None;
    }
    buf.truncate(got as usize);
    Some(String::from_utf16_lossy(&buf))
}

#[cfg(not(windows))]
fn decode_codepage(_bytes: &[u8], _cp: u32) -> Option<String> {
    None
}

// ---------------------------------------------------------------------------
// Parsing (pure; unit-tested)
// ---------------------------------------------------------------------------

/// Extract the card fields from `html`, resolving a relative image against
/// `base_url` (the requested URL — `http_win` does not report the post-redirect
/// one, which is fine for the usual root-relative `og:image`).
pub fn parse_og(html: &str, base_url: &str) -> Og {
    // Card metadata lives in <head>; stopping there keeps an inline <svg> or a
    // quoted snippet in the body from contributing a stray <title>.
    let lower = html.to_ascii_lowercase();
    let head_end = lower.find("</head>").unwrap_or(html.len());
    let head = &html[..head_end];

    let meta_re = regex::Regex::new(r"(?is)<meta\b[^>]*>").unwrap();
    let attr_re =
        regex::Regex::new(r#"(?is)([a-z_:\-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))"#).unwrap();

    // (priority, value) per field; lower priority number wins.
    let mut title: Option<(u8, String)> = None;
    let mut desc: Option<(u8, String)> = None;
    let mut site: Option<(u8, String)> = None;
    let mut image: Option<(u8, String)> = None;
    fn offer(slot: &mut Option<(u8, String)>, pri: u8, v: &str) {
        if v.trim().is_empty() {
            return;
        }
        if slot.as_ref().map(|(p, _)| pri < *p).unwrap_or(true) {
            *slot = Some((pri, v.to_string()));
        }
    }

    for m in meta_re.find_iter(head) {
        let mut key = String::new();
        let mut content = None;
        for c in attr_re.captures_iter(m.as_str()) {
            let name = c[1].to_ascii_lowercase();
            let val = c
                .get(2)
                .or_else(|| c.get(3))
                .or_else(|| c.get(4))
                .map(|v| v.as_str())
                .unwrap_or("");
            match name.as_str() {
                "property" | "name" if key.is_empty() => key = val.trim().to_ascii_lowercase(),
                "content" => content = Some(val.to_string()),
                _ => {}
            }
        }
        let Some(v) = content else { continue };
        match key.as_str() {
            "og:title" => offer(&mut title, 0, &v),
            "twitter:title" => offer(&mut title, 1, &v),
            "og:description" => offer(&mut desc, 0, &v),
            "twitter:description" => offer(&mut desc, 1, &v),
            "description" => offer(&mut desc, 2, &v),
            "og:site_name" => offer(&mut site, 0, &v),
            "application-name" => offer(&mut site, 1, &v),
            "og:image:secure_url" => offer(&mut image, 0, &v),
            "og:image" | "og:image:url" => offer(&mut image, 1, &v),
            "twitter:image" | "twitter:image:src" => offer(&mut image, 2, &v),
            _ => {}
        }
    }

    if title.is_none() {
        let title_re = regex::Regex::new(r"(?is)<title\b[^>]*>(.*?)</title>").unwrap();
        if let Some(c) = title_re.captures(head) {
            offer(&mut title, 9, &c[1]);
        }
    }

    let clean = |v: Option<(u8, String)>, max: usize| -> String {
        v.map(|(_, s)| truncate_chars(&collapse_ws(&decode_entities(&s)), max))
            .unwrap_or_default()
    };
    let image = image
        .map(|(_, s)| resolve_url(base_url, decode_entities(&s).trim()))
        .unwrap_or_default();
    Og {
        title: clean(title, TITLE_MAX_CHARS),
        desc: clean(desc, DESC_MAX_CHARS),
        site: clean(site, SITE_MAX_CHARS),
        image,
    }
}

/// Resolve `rel` against `base` (absolute, scheme://host/...). Dot segments are
/// left for the server, which resolves them the same way.
pub fn resolve_url(base: &str, rel: &str) -> String {
    let rel = rel.trim();
    if rel.is_empty() {
        return String::new();
    }
    let lower = rel.to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") {
        return rel.to_string();
    }
    if lower.starts_with("data:") || lower.starts_with("javascript:") {
        return String::new();
    }
    let Some(scheme_end) = base.find("://") else { return String::new() };
    let scheme = &base[..scheme_end];
    if let Some(rest) = rel.strip_prefix("//") {
        return format!("{}://{}", scheme, rest);
    }
    let after = &base[scheme_end + 3..];
    let host_end = after.find(['/', '?', '#']).unwrap_or(after.len());
    let origin = &base[..scheme_end + 3 + host_end];
    if rel.starts_with('/') {
        return format!("{}{}", origin, rel);
    }
    let path = &after[host_end..];
    let path = &path[..path.find(['?', '#']).unwrap_or(path.len())];
    let dir = match path.rfind('/') {
        Some(i) => &path[..=i],
        None => "/",
    };
    if rel.starts_with('?') {
        return format!("{}{}{}", origin, path, rel);
    }
    format!("{}{}{}", origin, dir, rel)
}

pub fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let re = regex::Regex::new(r"&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});").unwrap();
    re.replace_all(s, |c: &regex::Captures| {
        let e = &c[1];
        let ch = if let Some(hex) = e.strip_prefix("#x").or_else(|| e.strip_prefix("#X")) {
            u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
        } else if let Some(dec) = e.strip_prefix('#') {
            dec.parse::<u32>().ok().and_then(char::from_u32)
        } else {
            match e {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some(' '),
                "hellip" => Some('…'),
                "mdash" => Some('—'),
                "ndash" => Some('–'),
                "laquo" => Some('«'),
                "raquo" => Some('»'),
                "copy" => Some('©'),
                _ => None,
            }
        };
        match ch {
            Some(ch) => ch.to_string(),
            None => c[0].to_string(),
        }
    })
    .into_owned()
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_is_stable_and_valid() {
        let k = cache_key("https://example.com/");
        assert_eq!(k, cache_key("https://example.com/"));
        assert_ne!(k, cache_key("https://example.com/a"));
        assert!(is_valid_key(&k));
        // FNV-1a 64 of the empty string is the offset basis.
        assert_eq!(cache_key(""), "cbf29ce484222325");
    }

    #[test]
    fn key_validation_refuses_paths() {
        assert!(!is_valid_key("../../etc/passwd"));
        assert!(!is_valid_key("CBF29CE484222325"));
        assert!(!is_valid_key("cbf29ce48422232"));
        assert!(!is_valid_key("cbf29ce4842223256"));
    }

    #[test]
    fn parses_og_fields_with_priority() {
        let html = r#"<html><head>
            <title>Fallback</title>
            <meta name="description" content="plain desc">
            <meta property="og:description" content="og desc">
            <meta name="twitter:title" content="tw title">
            <meta property="og:title" content="OG &amp; Title">
            <meta content="Site" property="og:site_name">
            <meta property='og:image' content='/img/card.png'>
            </head><body><title>body</title></body></html>"#;
        let og = parse_og(html, "https://example.com/blog/post?x=1");
        assert_eq!(og.title, "OG & Title");
        assert_eq!(og.desc, "og desc");
        assert_eq!(og.site, "Site");
        assert_eq!(og.image, "https://example.com/img/card.png");
    }

    #[test]
    fn falls_back_to_title_tag_and_meta_description() {
        let html = "<head><TITLE>\n  Hello\n  World </TITLE><meta name=description content=desc></head>";
        let og = parse_og(html, "https://e.com/");
        assert_eq!(og.title, "Hello World");
        assert_eq!(og.desc, "desc");
        assert_eq!(og.image, "");
    }

    #[test]
    fn ignores_title_in_body() {
        let og = parse_og("<head></head><body><svg><title>x</title></svg></body>", "https://e.com/");
        assert_eq!(og.title, "");
    }

    #[test]
    fn resolves_urls() {
        let b = "https://e.com/a/b/page.html?q=1#f";
        assert_eq!(resolve_url(b, "https://cdn.x/i.png"), "https://cdn.x/i.png");
        assert_eq!(resolve_url(b, "//cdn.x/i.png"), "https://cdn.x/i.png");
        assert_eq!(resolve_url(b, "/i.png"), "https://e.com/i.png");
        assert_eq!(resolve_url(b, "i.png"), "https://e.com/a/b/i.png");
        assert_eq!(resolve_url("https://e.com", "i.png"), "https://e.com/i.png");
        assert_eq!(resolve_url(b, "data:image/png;base64,xx"), "");
        assert_eq!(resolve_url(b, ""), "");
    }

    #[test]
    fn decodes_entities() {
        assert_eq!(decode_entities("a &amp; b &#x3042;&#12354; &quot;q&quot; &bogus;"), "a & b ああ \"q\" &bogus;");
    }

    #[test]
    fn truncates_long_text() {
        let long = "あ".repeat(500);
        let og = parse_og(&format!("<head><meta property=og:title content=\"{}\"></head>", long), "https://e.com/");
        assert_eq!(og.title.chars().count(), TITLE_MAX_CHARS);
        assert!(og.title.ends_with('…'));
    }

    #[test]
    fn detects_charset() {
        assert_eq!(charset_codepage(br#"<meta charset="Shift_JIS">"#), Some(932));
        assert_eq!(charset_codepage(b"<meta http-equiv=Content-Type content='text/html; charset=EUC-JP'>"), Some(20932));
        assert_eq!(charset_codepage(br#"<meta charset="utf-8">"#), None);
        assert_eq!(charset_codepage(b"<html>"), None);
    }

    #[cfg(windows)]
    #[test]
    fn decodes_shift_jis() {
        // "日本" in Shift_JIS is 93 FA 96 7B.
        let mut bytes = br#"<head><meta charset="shift_jis"><title>"#.to_vec();
        bytes.extend_from_slice(&[0x93, 0xFA, 0x96, 0x7B]);
        bytes.extend_from_slice(b"</title></head>");
        let og = parse_og(&decode_html(&bytes), "https://e.com/");
        assert_eq!(og.title, "日本");
    }

    #[test]
    fn sniffs_images() {
        assert_eq!(sniff_image_mime(&[0x89, b'P', b'N', b'G', 0x0D]), Some("image/png"));
        assert_eq!(sniff_image_mime(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff_image_mime(b"GIF89a"), Some("image/gif"));
        assert_eq!(sniff_image_mime(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_image_mime(b"<html>"), None);
    }

    #[test]
    fn resolve_refuses_non_https_without_network() {
        assert!(!resolve("http://example.com/", false).ok);
        assert!(!resolve("not a url", false).ok);
    }

    // Network: `cargo test -- --ignored linkcard`. Hits the real site through
    // WinHTTP and writes to the real %TEMP% cache, so it is opt-in.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn fetches_a_real_card() {
        let m = resolve("https://github.com/", false);
        assert!(m.ok, "{:?}", m);
        assert!(!m.title.is_empty());
        // A second call is served from the disk cache, even cache-only.
        assert_eq!(resolve("https://github.com/", true), m);
        if !m.img.is_empty() {
            let key = m.img.trim_start_matches("/linkcard-img/");
            let bytes = std::fs::read(image_path(&cache_dir(), key)).unwrap();
            assert!(sniff_image_mime(&bytes).is_some());
        }
    }

    #[test]
    fn meta_json_shape() {
        let m = Meta { ok: true, title: "t".into(), desc: "d".into(), site: "s".into(), img: "".into() };
        assert_eq!(
            serde_json::to_string(&m).unwrap(),
            r#"{"ok":true,"title":"t","desc":"d","site":"s","img":""}"#
        );
    }
}
