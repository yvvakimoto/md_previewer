//! Minimal blocking HTTPS GET over **WinHTTP**. Windows-only.
//!
//! Exists solely for [`crate::updater`]'s GitHub Releases provider: one small
//! JSON fetch plus one installer download, both on a background thread.
//!
//! **Why WinHTTP and not an HTTP crate.** It costs no new dependency — the
//! `windows` crate is already pinned at 0.39 for `webview2-com`, and only the
//! `Win32_Networking_WinHttp` feature had to be switched on. More importantly
//! the OS then owns the parts an organisation actually cares about: TLS, the
//! Windows certificate store (so a corporate MITM proxy's root is trusted like
//! any other app's), and **proxy auto-discovery** via WPAD / IE settings. A
//! bundled-roots client would fail on exactly the intranet machines this
//! feature is for.
//!
//! Everything here is deliberately tiny and single-purpose: GET only, no
//! keep-alive reuse, no streaming API. Redirects are followed (a release asset
//! 302s from `github.com` to `objects.githubusercontent.com`), and every
//! response is capped so a hostile or broken server cannot exhaust memory or
//! the disk.

use std::io::{Error, ErrorKind, Result, Write};
use std::path::Path;

use windows::core::PCWSTR;
use windows::Win32::Networking::WinHttp::{
    WinHttpCloseHandle, WinHttpConnect, WinHttpCrackUrl, WinHttpOpen, WinHttpOpenRequest,
    WinHttpQueryDataAvailable, WinHttpQueryHeaders, WinHttpReadData, WinHttpReceiveResponse,
    WinHttpSendRequest, WinHttpSetTimeouts, INTERNET_PORT, URL_COMPONENTS,
    WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_FLAG_SECURE, WINHTTP_QUERY_FLAG_NUMBER,
    WINHTTP_QUERY_STATUS_CODE,
};

/// `WinHttpQueryHeaders`' "no name" / "no index" sentinels. The `windows` 0.39
/// bindings do not re-export them as typed constants.
const WINHTTP_NO_HEADER_INDEX: *mut u32 = std::ptr::null_mut();

/// One read chunk. `WinHttpQueryDataAvailable` reports what is buffered, but we
/// still cap each `WinHttpReadData` so a large body streams instead of forcing
/// one huge allocation.
const READ_CHUNK: usize = 64 * 1024;

/// UTF-16, NUL-terminated — every WinHTTP string parameter wants this.
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// RAII wrapper around a WinHTTP handle.
///
/// The happy path here is five nested handles with a fallible step between each
/// one; closing them by hand meant a `WinHttpCloseHandle` before every early
/// `return`, which is precisely the kind of thing that rots. `Drop` does it.
struct Handle(*mut std::ffi::c_void);

impl Handle {
    /// `Err` (rather than a null handle) for any WinHTTP call that failed.
    fn new(raw: *mut std::ffi::c_void, what: &str) -> Result<Self> {
        if raw.is_null() {
            return Err(Error::other(format!(
                "{} failed: {}",
                what,
                Error::last_os_error()
            )));
        }
        Ok(Handle(raw))
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                let _ = WinHttpCloseHandle(self.0);
            }
        }
    }
}

/// Host + path-with-query, split by `WinHttpCrackUrl`.
///
/// Parsing this by hand is a classic source of subtle bugs (ports, empty paths,
/// `?query` vs `#fragment`), and WinHTTP ships the exact parser its own
/// `WinHttpConnect`/`WinHttpOpenRequest` expect — so we use that.
struct CrackedUrl {
    host: String,
    /// Path *and* query, which is what `WinHttpOpenRequest` calls the "object".
    object: String,
    port: u16,
    https: bool,
}

fn crack_url(url: &str) -> Result<CrackedUrl> {
    let w = wide(url);
    // `dwStructSize` must be set, and a zeroed length + null pointer asks
    // WinHttpCrackUrl to hand back pointers *into* our own buffer rather than
    // copying — hence the `dwXxxLength` fields being read back as lengths.
    let mut comp = URL_COMPONENTS {
        dwStructSize: std::mem::size_of::<URL_COMPONENTS>() as u32,
        ..Default::default()
    };
    comp.dwHostNameLength = u32::MAX;
    comp.dwUrlPathLength = u32::MAX;
    comp.dwExtraInfoLength = u32::MAX;
    comp.dwSchemeLength = u32::MAX;

    // The trailing NUL must not be counted, or it lands inside the host slice.
    let len = w.len() - 1;
    let ok = unsafe { WinHttpCrackUrl(&w[..len], 0, &mut comp) };
    if !ok.as_bool() {
        return Err(Error::new(
            ErrorKind::InvalidInput,
            format!(
                "WinHttpCrackUrl failed for {}: {}",
                url,
                Error::last_os_error()
            ),
        ));
    }

    unsafe fn take(p: windows::core::PWSTR, n: u32) -> String {
        if p.is_null() || n == 0 {
            return String::new();
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(p.0, n as usize))
    }

    let host = unsafe { take(comp.lpszHostName, comp.dwHostNameLength) };
    let path = unsafe { take(comp.lpszUrlPath, comp.dwUrlPathLength) };
    let extra = unsafe { take(comp.lpszExtraInfo, comp.dwExtraInfoLength) };
    let scheme = unsafe { take(comp.lpszScheme, comp.dwSchemeLength) };

    if host.is_empty() {
        return Err(Error::new(
            ErrorKind::InvalidInput,
            format!("no host in {}", url),
        ));
    }
    let mut object = if path.is_empty() {
        "/".to_string()
    } else {
        path
    };
    object.push_str(&extra);

    Ok(CrackedUrl {
        host,
        object,
        port: comp.nPort,
        https: scheme.eq_ignore_ascii_case("https"),
    })
}

/// An open response, ready to be drained by [`read_body`].
///
/// The handles are returned alongside so the caller keeps them alive: dropping
/// the session or connection would tear the request down mid-read.
struct Response {
    _session: Handle,
    _connect: Handle,
    request: Handle,
    status: u32,
}

/// Issue the GET and read the status line, leaving the body unread.
fn send(url: &str, accept: &str, timeout_ms: u64) -> Result<Response> {
    let u = crack_url(url)?;
    if !u.https {
        // Nothing here should ever be plaintext; refuse rather than downgrade.
        return Err(Error::new(
            ErrorKind::InvalidInput,
            format!("refusing non-https url {}", url),
        ));
    }

    let agent = wide(&format!("md-previewer/{}", env!("CARGO_PKG_VERSION")));
    // `WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY` makes WinHTTP resolve the proxy the
    // way the rest of the desktop does (WPAD, then the IE/system settings).
    let session = Handle::new(
        unsafe {
            WinHttpOpen(
                PCWSTR(agent.as_ptr()),
                WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                PCWSTR::null(),
                PCWSTR::null(),
                0,
            )
        },
        "WinHttpOpen",
    )?;

    // WinHTTP's timeouts are per phase, not per request. The caller still wraps
    // the whole thing in a wall-clock guard (see `updater::run_with_timeout`);
    // these just stop a single phase from hanging for the TCP default.
    let t = timeout_ms.min(i32::MAX as u64) as i32;
    unsafe {
        let _ = WinHttpSetTimeouts(session.0, t, t, t, t);
    }

    let host_w = wide(&u.host);
    let connect = Handle::new(
        unsafe {
            WinHttpConnect(
                session.0,
                PCWSTR(host_w.as_ptr()),
                INTERNET_PORT(u.port as u32),
                0,
            )
        },
        "WinHttpConnect",
    )?;

    let verb = wide("GET");
    let object_w = wide(&u.object);
    let request = Handle::new(
        unsafe {
            WinHttpOpenRequest(
                connect.0,
                PCWSTR(verb.as_ptr()),
                PCWSTR(object_w.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                std::ptr::null_mut(),
                WINHTTP_FLAG_SECURE,
            )
        },
        "WinHttpOpenRequest",
    )?;

    // Redirects are followed by default, which the asset download needs
    // (github.com -> objects.githubusercontent.com). WinHTTP will not downgrade
    // https -> http on its own, so no extra policy is set here.
    let headers = wide(&format!("Accept: {}\r\n", accept));
    let hlen = headers.len() - 1; // exclude the NUL
    let ok = unsafe { WinHttpSendRequest(request.0, &headers[..hlen], std::ptr::null(), 0, 0, 0) };
    if !ok.as_bool() {
        return Err(Error::other(format!(
            "WinHttpSendRequest failed: {}",
            Error::last_os_error()
        )));
    }

    let ok = unsafe { WinHttpReceiveResponse(request.0, std::ptr::null_mut()) };
    if !ok.as_bool() {
        return Err(Error::other(format!(
            "WinHttpReceiveResponse failed: {}",
            Error::last_os_error()
        )));
    }

    let mut status: u32 = 0;
    let mut len = std::mem::size_of::<u32>() as u32;
    let ok = unsafe {
        WinHttpQueryHeaders(
            request.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            PCWSTR::null(),
            &mut status as *mut u32 as *mut std::ffi::c_void,
            &mut len,
            WINHTTP_NO_HEADER_INDEX,
        )
    };
    if !ok.as_bool() {
        return Err(Error::other(format!(
            "WinHttpQueryHeaders failed: {}",
            Error::last_os_error()
        )));
    }

    Ok(Response {
        _session: session,
        _connect: connect,
        request,
        status,
    })
}

/// Map a non-2xx status onto an `io::Error`, naming the rate-limit case.
///
/// 403/429 from `api.github.com` means the **unauthenticated 60 requests/hour
/// per IP** budget is spent — plausible for a whole office behind one NAT, and
/// otherwise indistinguishable in the log from "no update". `updater`'s check
/// throttle exists to keep this from happening; saying so here is what makes it
/// diagnosable when it does.
fn status_error(status: u32, url: &str) -> Error {
    let hint = if status == 403 || status == 429 {
        " (rate limited?)"
    } else {
        ""
    };
    Error::other(format!("HTTP {}{} for {}", status, hint, url))
}

/// Drain the response body, writing each chunk through `sink`.
///
/// Returns the total byte count, or an error once `max_bytes` is exceeded —
/// the cap is enforced *during* the read, so an endless body is cut off rather
/// than buffered first.
fn read_body<F: FnMut(&[u8]) -> Result<()>>(
    resp: &Response,
    max_bytes: u64,
    mut sink: F,
) -> Result<u64> {
    let mut total: u64 = 0;
    let mut buf = vec![0u8; READ_CHUNK];
    loop {
        let mut avail: u32 = 0;
        let ok = unsafe { WinHttpQueryDataAvailable(resp.request.0, &mut avail) };
        if !ok.as_bool() {
            return Err(Error::other(format!(
                "WinHttpQueryDataAvailable failed: {}",
                Error::last_os_error()
            )));
        }
        if avail == 0 {
            return Ok(total);
        }
        let want = (avail as usize).min(buf.len());
        let mut got: u32 = 0;
        let ok = unsafe {
            WinHttpReadData(
                resp.request.0,
                buf.as_mut_ptr() as *mut std::ffi::c_void,
                want as u32,
                &mut got,
            )
        };
        if !ok.as_bool() {
            return Err(Error::other(format!(
                "WinHttpReadData failed: {}",
                Error::last_os_error()
            )));
        }
        if got == 0 {
            return Ok(total);
        }
        total += got as u64;
        if total > max_bytes {
            return Err(Error::new(
                ErrorKind::InvalidData,
                format!("response exceeded {} bytes", max_bytes),
            ));
        }
        sink(&buf[..got as usize])?;
    }
}

/// GET `url` into memory. For the release manifest — small JSON, so `max_bytes`
/// is a sanity cap rather than a real limit.
pub fn get(url: &str, accept: &str, timeout_ms: u64, max_bytes: u64) -> Result<Vec<u8>> {
    let resp = send(url, accept, timeout_ms)?;
    if !(200..300).contains(&resp.status) {
        return Err(status_error(resp.status, url));
    }
    let mut out: Vec<u8> = Vec::new();
    read_body(&resp, max_bytes, |chunk| {
        out.extend_from_slice(chunk);
        Ok(())
    })?;
    Ok(out)
}

/// GET `url` straight to `dest`, returning the byte count.
///
/// Streams through a `BufWriter` so a multi-MB installer never sits in memory.
/// The caller is responsible for staging (`.part` + rename) and for checking the
/// count against the size the manifest advertised.
pub fn download(url: &str, dest: &Path, timeout_ms: u64, max_bytes: u64) -> Result<u64> {
    let resp = send(url, accept_any(), timeout_ms)?;
    if !(200..300).contains(&resp.status) {
        return Err(status_error(resp.status, url));
    }
    let file = std::fs::File::create(dest)?;
    let mut w = std::io::BufWriter::new(file);
    let n = read_body(&resp, max_bytes, |chunk| w.write_all(chunk))?;
    w.flush()?;
    Ok(n)
}

fn accept_any() -> &'static str {
    "*/*"
}

#[cfg(test)]
mod tests {
    use super::*;

    // `crack_url` is the only part of this module that is pure enough to test
    // without a network: it neither opens a handle nor sends anything.

    #[test]
    fn cracks_a_github_api_url() {
        let u = crack_url("https://api.github.com/repos/o/r/releases/latest").unwrap();
        assert_eq!(u.host, "api.github.com");
        assert_eq!(u.object, "/repos/o/r/releases/latest");
        assert_eq!(u.port, 443);
        assert!(u.https);
    }

    #[test]
    fn keeps_the_query_string() {
        let u = crack_url("https://example.com/a/b?x=1&y=2").unwrap();
        assert_eq!(u.object, "/a/b?x=1&y=2");
    }

    #[test]
    fn bare_host_gets_a_root_path() {
        let u = crack_url("https://example.com").unwrap();
        assert_eq!(u.object, "/");
    }

    #[test]
    fn reports_plain_http_as_not_https() {
        // `send` refuses these; `crack_url` only has to classify them.
        let u = crack_url("http://example.com/x").unwrap();
        assert!(!u.https);
        assert_eq!(u.port, 80);
    }

    #[test]
    fn rejects_garbage() {
        assert!(crack_url("not a url").is_err());
    }

    /// Live end-to-end proof that the handle chain, the TLS handshake and the
    /// chunked read all work. Ignored by default because it needs the network:
    /// `cargo test -- --ignored live_get`.
    #[test]
    #[ignore]
    fn live_get() {
        let body = get(
            "https://api.github.com/repos/yvvakimoto/md_previewer/releases/latest",
            "application/vnd.github+json",
            8000,
            2 * 1024 * 1024,
        )
        .expect("live GET should succeed");
        let text = String::from_utf8_lossy(&body);
        assert!(
            text.contains("\"tag_name\""),
            "unexpected body: {}",
            &text[..text.len().min(200)]
        );
    }
}
