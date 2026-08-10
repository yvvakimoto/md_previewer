#!/usr/bin/env python3
"""Browser preview harness for md_previewer.

Serves the *real* ``assets/index.html`` over plain HTTP so the whole previewer
UI can be opened in a browser (in particular Claude Code's in-app Browser pane)
and screenshotted / inspected live — with **no ``cargo build``**.

The Rust+WebView2 host normally does three things this server reproduces at
serve time so ``index.html`` boots unchanged:

1. Injects globals via a WebView2 init script (``__appVersion`` / ``__userStyles``
   / ``__marpThemes`` / ``__styleExporters``). We inject an equivalent bootstrap
   ``<script>`` right after the opening ``<head>`` tag (the on-disk file is never
   modified).
2. Calls ``window.loadFileFromRust({filename, filepath, content, raw})`` to load
   the initial document. The injected bootstrap does this from a ``?file=<abs>``
   query param, fetching the raw markdown from ``/__doc``.
3. Serves local images/CSV/video through the ``/userfile/`` route, resolved
   against the current document's directory, with HTTP ``Range`` support.

IPC (save / export / open-editor / cross-file nav) is stubbed with a logging
shim — those flows are intentional no-ops under the harness. To view a different
document, navigate to a new ``?file=`` URL (this re-points the ``/userfile/`` base).

Usage:
    python tools/preview-harness/serve.py [--port 8770] [--root <repo root>]
    # then open: http://localhost:8770/index.html?file=<ABSOLUTE .md path>

Stdlib only — no third-party dependencies.
"""

import argparse
import json
import mimetypes
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs, unquote

# ---------------------------------------------------------------------------
# Server-side state: the directory the current document lives in. The preview's
# `/userfile/` URLs are relative to this (mirrors Rust's `current_dir`).
# ---------------------------------------------------------------------------
_STATE_LOCK = threading.Lock()
CURRENT_BASE = None  # type: str | None

# Extra MIME types beyond what the stdlib knows (mirrors get_mime_type in main.rs).
EXTRA_MIME = {
    ".md": "text/markdown; charset=utf-8",
    ".markdown": "text/markdown; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".tsv": "text/tab-separated-values; charset=utf-8",
    ".mov": "video/quicktime",
    ".mp4": "video/mp4",
    ".m4v": "video/x-m4v",
    ".webm": "video/webm",
    ".ogv": "video/ogg",
    ".ogg": "video/ogg",
    ".mjs": "text/javascript; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".avif": "image/avif",
    ".wasm": "application/wasm",
}


def guess_mime(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in EXTRA_MIME:
        return EXTRA_MIME[ext]
    mime, _ = mimetypes.guess_type(path)
    return mime or "application/octet-stream"


def read_cargo_version(repo_root):
    """Best-effort read of [package] version = "x.y.z" from Cargo.toml."""
    try:
        with open(os.path.join(repo_root, "Cargo.toml"), "r", encoding="utf-8") as f:
            text = f.read()
        m = re.search(r'(?m)^\s*version\s*=\s*"([^"]+)"', text)
        if m:
            return m.group(1)
    except OSError:
        pass
    return "0.0.0-harness"


def scan_user_styles(assets_dir):
    """assets/*.css minus editor.css (matches the S-key style picker list)."""
    try:
        names = [
            n for n in os.listdir(assets_dir)
            if n.lower().endswith(".css") and n.lower() != "editor.css"
        ]
        return sorted(names)
    except OSError:
        return []


def scan_marp_themes(assets_dir):
    """assets/marp/*.css basenames (matches __marpThemes)."""
    marp_dir = os.path.join(assets_dir, "marp")
    try:
        names = [n for n in os.listdir(marp_dir) if n.lower().endswith(".css")]
        return sorted(names)
    except OSError:
        return []


def build_bootstrap(repo_root, assets_dir):
    """The <script> injected right after <head>. Sets Rust-injected globals,
    installs an IPC logging shim, and auto-loads a ?file= document."""
    version = read_cargo_version(repo_root)
    user_styles = scan_user_styles(assets_dir)
    marp_themes = scan_marp_themes(assets_dir)
    payload = {
        "appVersion": version,
        "userStyles": user_styles,
        "marpThemes": marp_themes,
    }
    cfg = json.dumps(payload)
    # NOTE: keep this pure ASCII so it never disturbs UTF-8 charset detection.
    return (
        "<script>/* md_previewer preview-harness bootstrap (injected) */\n"
        "(function(){\n"
        "  var H = " + cfg + ";\n"
        "  window.__appVersion = H.appVersion;\n"
        "  window.__userStyles = H.userStyles;\n"
        "  window.__marpThemes = H.marpThemes;\n"
        "  window.__styleExporters = {};\n"
        "  // Logging IPC shim: guarded flows (save/export/openmd/editor) become\n"
        "  // visible no-ops instead of throwing. --export-png capture is NOT\n"
        "  // triggered because window.__captureConfig is never set here.\n"
        "  if (!window.ipc) window.ipc = {};\n"
        "  if (typeof window.ipc.postMessage !== 'function') {\n"
        "    window.ipc.postMessage = function(m){ try { console.debug('[ipc]', m); } catch(e){} };\n"
        "  }\n"
        "  function qparam(name){\n"
        "    try { return new URLSearchParams(window.location.search).get(name); }\n"
        "    catch(e){ return null; }\n"
        "  }\n"
        "  function basename(p){\n"
        "    var s = String(p).replace(/[\\\\]/g,'/');\n"
        "    var i = s.lastIndexOf('/');\n"
        "    return i >= 0 ? s.slice(i+1) : s;\n"
        "  }\n"
        "  var tries = 0;\n"
        "  function boot(){\n"
        "    var file = qparam('file');\n"
        "    if (!file) return; // no ?file= -> let the app show its drop zone\n"
        "    if (typeof window.loadFileFromRust !== 'function') {\n"
        "      if (tries++ < 100) { setTimeout(boot, 100); }\n"
        "      return;\n"
        "    }\n"
        "    fetch('/__doc?path=' + encodeURIComponent(file))\n"
        "      .then(function(r){ if(!r.ok) throw new Error('doc fetch '+r.status); return r.text(); })\n"
        "      .then(function(text){\n"
        "        window.loadFileFromRust({\n"
        "          filename: basename(file),\n"
        "          filepath: file,\n"
        "          content: text,\n"
        "          raw: text\n"
        "        });\n"
        "        console.debug('[harness] loaded', file);\n"
        "      })\n"
        "      .catch(function(e){ console.error('[harness] load failed', e); });\n"
        "  }\n"
        "  if (document.readyState === 'loading') {\n"
        "    document.addEventListener('DOMContentLoaded', boot);\n"
        "  } else { boot(); }\n"
        "})();\n"
        "</script>\n"
    )


def resolve_userfile(rel_or_abs):
    """Mirror Rust's /userfile/ resolver: absolute paths pass through; relative
    paths are component-walked against CURRENT_BASE (handling .. and .)."""
    p = rel_or_abs.replace("/", os.sep)
    if os.path.isabs(p):
        return p
    with _STATE_LOCK:
        base = CURRENT_BASE
    if not base:
        return None
    resolved = base
    for comp in p.split(os.sep):
        if comp in ("", "."):
            continue
        if comp == "..":
            resolved = os.path.dirname(resolved)
        else:
            resolved = os.path.join(resolved, comp)
    return resolved


def parse_byte_range(header, total):
    """Parse a single 'bytes=start-end' range. Returns (start, end) inclusive."""
    m = re.match(r"bytes=(\d*)-(\d*)$", header.strip())
    if not m:
        return None
    start_s, end_s = m.group(1), m.group(2)
    if start_s == "" and end_s == "":
        return None
    if start_s == "":
        # suffix range: last N bytes
        n = int(end_s)
        if n == 0:
            return None
        start = max(0, total - n)
        end = total - 1
    else:
        start = int(start_s)
        end = int(end_s) if end_s != "" else total - 1
    if start > end or start >= total:
        return None
    end = min(end, total - 1)
    return (start, end)


class Handler(BaseHTTPRequestHandler):
    server_version = "MdPreviewHarness/1.0"
    protocol_version = "HTTP/1.1"

    # --- helpers -----------------------------------------------------------
    def _send_bytes(self, body, status=200, mime="application/octet-stream", extra=None):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_text(self, text, status=200, mime="text/plain; charset=utf-8"):
        self._send_bytes(text.encode("utf-8"), status, mime)

    def _not_found(self, msg="Not found"):
        self._send_text(msg, 404)

    # --- routes ------------------------------------------------------------
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        parts = urlsplit(self.path)
        path = unquote(parts.path)
        query = parse_qs(parts.query)

        if path in ("/", "/index.html"):
            # Record base from ?file= as a fallback (the /__doc fetch also sets it).
            f = query.get("file", [None])[0]
            if f:
                self._set_base_from_file(f)
            return self._serve_index()

        if path == "/__doc":
            return self._serve_doc(query.get("path", [None])[0])

        if path.startswith("/userfile/"):
            return self._serve_userfile(path[len("/userfile/"):])

        if path.startswith("/__log"):
            return self._send_text("ok")  # swallow forensic logging fetches

        # Static asset from the assets directory.
        return self._serve_static(path)

    def do_POST(self):
        # IPC shim posts nothing to the server; accept and ignore.
        self._send_text("ok")

    # --- route impls -------------------------------------------------------
    def _set_base_from_file(self, file_path):
        global CURRENT_BASE
        d = os.path.dirname(file_path.replace("/", os.sep))
        if d:
            with _STATE_LOCK:
                CURRENT_BASE = d

    def _serve_index(self):
        index_path = os.path.join(self.server.assets_dir, "index.html")
        try:
            with open(index_path, "r", encoding="utf-8") as fh:
                html = fh.read()
        except OSError as e:
            return self._send_text("index.html not found: %s" % e, 500)
        boot = build_bootstrap(self.server.repo_root, self.server.assets_dir)
        # Insert right after the opening <head> tag.
        m = re.search(r"<head[^>]*>", html, re.IGNORECASE)
        if m:
            idx = m.end()
            html = html[:idx] + "\n" + boot + html[idx:]
        else:
            html = boot + html
        self._send_bytes(html.encode("utf-8"), 200, "text/html; charset=utf-8")

    def _serve_doc(self, path):
        if not path:
            return self._send_text("missing path", 400)
        self._set_base_from_file(path)
        try:
            with open(path.replace("/", os.sep), "rb") as fh:
                body = fh.read()
        except OSError as e:
            return self._send_text("doc read failed: %s" % e, 404)
        self._send_bytes(body, 200, "text/markdown; charset=utf-8")

    def _serve_userfile(self, rel):
        resolved = resolve_userfile(rel)
        if not resolved:
            return self._not_found("No document loaded (userfile base unset)")
        if not os.path.isfile(resolved):
            return self._not_found("userfile not found: %s" % rel)
        self._serve_file_with_range(resolved)

    def _serve_static(self, path):
        rel = path.lstrip("/")
        # Prevent escaping the assets dir.
        target = os.path.normpath(os.path.join(self.server.assets_dir, rel))
        if not target.startswith(os.path.normpath(self.server.assets_dir)):
            return self._not_found("forbidden")
        if not os.path.isfile(target):
            return self._not_found("not found: %s" % path)
        self._serve_file_with_range(target)

    def _serve_file_with_range(self, filepath):
        try:
            total = os.path.getsize(filepath)
        except OSError as e:
            return self._not_found(str(e))
        mime = guess_mime(filepath)
        range_header = self.headers.get("Range")
        rng = parse_byte_range(range_header, total) if range_header else None
        try:
            with open(filepath, "rb") as fh:
                if rng:
                    start, end = rng
                    fh.seek(start)
                    body = fh.read(end - start + 1)
                    self.send_response(206)
                    self.send_header("Content-Type", mime)
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, total))
                    self.send_header("Accept-Ranges", "bytes")
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    if self.command != "HEAD":
                        self.wfile.write(body)
                else:
                    body = fh.read()
                    self.send_response(200)
                    self.send_header("Content-Type", mime)
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Accept-Ranges", "bytes")
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    if self.command != "HEAD":
                        self.wfile.write(body)
        except OSError as e:
            self._not_found(str(e))

    # Quieter logging: one line per request to stderr.
    def log_message(self, fmt, *args):
        sys.stderr.write("[harness] %s - %s\n" % (self.address_string(), fmt % args))


def main():
    ap = argparse.ArgumentParser(description="md_previewer browser preview harness")
    ap.add_argument("--port", type=int, default=8770, help="listen port (default 8770)")
    ap.add_argument("--host", default="127.0.0.1", help="bind host (default 127.0.0.1)")
    ap.add_argument("--root", default=None,
                    help="repo root (default: two levels up from this script)")
    ap.add_argument("--assets", default=None,
                    help="assets dir (default: <root>/assets)")
    args = ap.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.abspath(args.root) if args.root else os.path.abspath(
        os.path.join(script_dir, "..", ".."))
    assets_dir = os.path.abspath(args.assets) if args.assets else os.path.join(repo_root, "assets")

    if not os.path.isfile(os.path.join(assets_dir, "index.html")):
        sys.stderr.write("ERROR: index.html not found under %s\n" % assets_dir)
        sys.exit(1)

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.repo_root = repo_root
    httpd.assets_dir = assets_dir

    sys.stderr.write(
        "md_previewer preview-harness listening on http://%s:%d\n"
        "  assets: %s\n"
        "  open:   http://%s:%d/index.html?file=<ABSOLUTE .md path>\n"
        % (args.host, args.port, assets_dir, args.host, args.port)
    )
    sys.stderr.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
