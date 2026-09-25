#!/usr/bin/env python
"""Keep every copy of a bundled library's version pin agreeing with the source.

    python tools/preview-harness/pincheck.py

`tools/fetch-libs.ps1` is the one place that decides which version of marked,
KaTeX, highlight.js, Plotly, tikzjax, ... actually lands in `assets/libs/`.
CLAUDE.md invariant 22 records that bumping one of them is a SEVEN-place change,
and three of those places are hand-maintained copies of a pin that cannot read
`fetch-libs.ps1` at all. This check pairs them.

WHY THIS EXISTS: both unchecked mirrors had ALREADY drifted when the invariant
was audited, and neither drift was visible in a commit diff, because
`assets/libs/**` and `THIRD_PARTY_LICENSES.txt` are git-ignored — the only thing
a bump commits is the pin files themselves.

  * `tools/collect-licenses.ps1` carried KaTeX as `'0.16.x'` and Mermaid as
    `'(bundled)'` — i.e. no pin at all. That array feeds the shipped
    `assets/THIRD_PARTY_LICENSES.txt`, so drift there is a FALSE LEGAL NOTICE,
    and re-running the script does not fix it: the versions are hard-coded.
  * `assets/index.html`'s `EXPORT_*_CDN` constants read highlight.js `11.10.0`
    against a fetched `11.9.0`. Those URLs are baked into every HTML export, so
    a reader of an exported document gets a different library than the author
    previewed with.

Also checked, because it is the same class of bug:

  * `installer/md-previewer.iss`'s `#define TikzjaxVersion` — the .iss cannot
    read the PowerShell script, so the installer can silently download a
    different tikzjax than a dev build fetches. Its `TikzjaxSha256` is
    deliberately NOT verified here: that would need the network, and this check
    stays offline. A wrong digest fails loudly at install time anyway; a wrong
    version does not.
  * `build.ps1`'s `$libsSentinels` — a library with no sentinel is never
    re-fetched into an existing checkout, and the built tree 404s at runtime.

STDLIB ONLY -- no Playwright, no Chromium, no network, well under a second.
Every file compared here sits on disk as literal text; nothing is executed, the
PowerShell and HTML are read with regexes. `docskeycheck.py` and `skillcheck.py`
are the precedents, and the same reasoning applies: cheap enough for a
pre-commit hook, and runnable by someone with no browser installed.

Every map below is FAIL-CLOSED. A library renamed or added on the mirror side
without a matching entry here is reported as a failure rather than silently
skipped -- an unknown entry is exactly the case this check exists to catch.
"""

import argparse
import os
import re
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

FETCH_LIBS = os.path.join(REPO_ROOT, "tools", "fetch-libs.ps1")
COLLECT_LIC = os.path.join(REPO_ROOT, "tools", "collect-licenses.ps1")
APP_HTML = os.path.join(REPO_ROOT, "assets", "index.html")
INSTALLER_ISS = os.path.join(REPO_ROOT, "installer", "md-previewer.iss")
BUILD_PS1 = os.path.join(REPO_ROOT, "build.ps1")

# ---- The maps ------------------------------------------------------------
# collect-licenses.ps1's $direct entry Name -> the fetch-libs.ps1 pin variable
# that decides what actually ships. Keyed by Name because that is the only
# stable identifier in the array; a rename therefore lands in UNPINNED_LICENSES
# below or fails, which is the intent.
LICENSE_PINS = {
    "marked": "MarkedVersion",
    "highlight.js": "HljsVersion",
    "KaTeX": "KatexVersion",
    "KaTeX Fonts": "KatexVersion",
    "Mermaid": "MermaidVersion",
    "Plotly.js (dist-min)": "PlotlyVersion",
    "js-yaml": "JsYamlVersion",
    "abcjs": "AbcjsVersion",
    "Kataskeve": "KataskeveVersion",
    "Kataskeve3D": "Kataskeve3dVersion",
    "feynmark": "FeynmarkVersion",
    "@rod2ik/tikzjax (WASM TeX + TikZ/pgf/tikz-cd)": "TikzjaxVersion",
}

# $direct entries that legitimately have no fetch-libs.ps1 pin to agree with.
# Listed explicitly so that a NEW unpinned entry has to be justified here rather
# than pass by default.
UNPINNED_LICENSES = {
    # Version is the upstream project name, not a release: the sound bank is
    # fetched per-note by fetch-libs.ps1 / the installer and upstream publishes
    # no version at all.
    "FluidR3_GM sound bank (ABC playback)":
        "the sound bank has no upstream version; fetch-libs pins the note list, not a release",
    # Vendored inside three.iife.js by three itself -- fetch-libs never sees it,
    # tools/build-three/package.json decides the three version that carries it.
    "fflate":
        "vendored inside three.iife.js; not fetched by fetch-libs.ps1",
}

# assets/index.html's CDN constants -> the pin the baked-in URL must carry.
EXPORT_PINS = {
    "EXPORT_KATEX_CSS_CDN": "KatexVersion",
    "EXPORT_HLJS_CSS_CDN": "HljsVersion",
    "EXPORT_PLOTLY_JS_CDN": "PlotlyVersion",
}

# assets/libs/<group> trees that build.ps1 must have a sentinel for but that
# fetch-libs.ps1 does not download: the esbuild IIFE bundles, built by
# tools/build-<group>/ and installed by install-deps.ps1. Derived from disk so a
# fifth bundle needs no edit here.
def bundle_groups():
    tools = os.path.join(REPO_ROOT, "tools")
    return set(
        name[len("build-"):]
        for name in os.listdir(tools)
        if name.startswith("build-") and os.path.isdir(os.path.join(tools, name))
    )


fail = 0


def check(label, ok, detail=""):
    global fail
    if not ok:
        fail += 1
    print(("ok   " if ok else "FAIL ") + label + ("" if ok else "  " + detail))


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def slice_array(src, opener, path):
    """Return the text of a PowerShell `<opener>@(` ... `)` array literal.

    Bounded so that the `$(...)` interpolations further down the file (which
    also carry braces and quotes) can never be mistaken for array members.
    """
    start = src.find(opener)
    if start < 0:
        raise SystemExit("pincheck: %s has no %r" % (path, opener))
    end = src.find("\n)", start)
    if end < 0:
        raise SystemExit("pincheck: %s: unterminated array after %r" % (path, opener))
    return src[start:end]


def url_version(url):
    """Pull the `@<version>/` out of a jsdelivr/cdnjs URL, or None."""
    m = re.search(r"@(\d[^/@]*)/", url)
    return m.group(1) if m else None


# ---- 1. the source of truth ---------------------------------------------
def fetch_pins(src):
    """{'KatexVersion': '0.18.9', ...} from fetch-libs.ps1's pin block."""
    return dict(re.findall(r"^\$(\w+Version)\s*=\s*'([^']+)'", src, re.M))


# ---- 2. collect-licenses.ps1's $direct array -----------------------------
def check_licenses(pins, lic_src):
    region = slice_array(lic_src, "$direct = @(", COLLECT_LIC)

    declared = len(re.findall(r"\[pscustomobject\]@\{", region))
    entries = re.findall(r"Name\s*=\s*'([^']*)'\s*;\s*Version\s*=\s*'([^']*)'", region)
    check("collect-licenses: every $direct entry parsed",
          len(entries) == declared,
          "parsed %d of %d entries -- the Name=...; Version=... shape changed"
          % (len(entries), declared))

    for name, version in entries:
        label = "collect-licenses: %s" % name
        if name in UNPINNED_LICENSES:
            check(label + " (unpinned, by design)", True)
            continue
        var = LICENSE_PINS.get(name)
        if var is None:
            check(label, False,
                  "not in pincheck.py's LICENSE_PINS -- map it to a fetch-libs.ps1 "
                  "pin, or add it to UNPINNED_LICENSES with a reason")
            continue
        want = pins.get(var)
        if want is None:
            check(label, False, "fetch-libs.ps1 has no $%s" % var)
            continue
        check(label, version == want,
              "THIRD_PARTY_LICENSES would say %r, fetch-libs.ps1 fetches %r ($%s)"
              % (version, want, var))

    seen = set(n for n, _ in entries)
    for name in LICENSE_PINS:
        if name not in seen:
            check("collect-licenses: %s present" % name, False,
                  "pincheck.py expects this $direct entry -- it was renamed or removed")


# ---- 3. assets/index.html's EXPORT_*_CDN constants -----------------------
def check_export_cdn(pins, app_src):
    found = re.findall(r"const\s+(EXPORT_\w*_CDN)\s*=\s*'([^']+)'", app_src)
    check("index.html: EXPORT_*_CDN constants found", bool(found),
          "none matched -- the declaration shape changed")

    for const, url in found:
        label = "index.html: %s" % const
        var = EXPORT_PINS.get(const)
        if var is None:
            check(label, False,
                  "not in pincheck.py's EXPORT_PINS -- a new CDN URL is baked into "
                  "every HTML export and nothing is checking its version")
            continue
        got = url_version(url)
        want = pins.get(var)
        if got is None:
            check(label, False, "no @<version>/ in %r" % url)
            continue
        if want is None:
            check(label, False, "fetch-libs.ps1 has no $%s" % var)
            continue
        check(label, got == want,
              "every HTML export would load %s, the app bundles %s ($%s)"
              % (got, want, var))

    seen = set(c for c, _ in found)
    for const in EXPORT_PINS:
        if const not in seen:
            check("index.html: %s present" % const, False,
                  "pincheck.py expects this constant -- it was renamed or removed")


# ---- 4. installer/md-previewer.iss's tikzjax pin -------------------------
def check_installer(pins, iss_src):
    m = re.search(r'#define\s+TikzjaxVersion\s+"([^"]+)"', iss_src)
    if not m:
        check("installer: #define TikzjaxVersion found", False,
              "the define is gone -- the installer downloads tikzjax unpinned?")
        return
    want = pins.get("TikzjaxVersion")
    check("installer: TikzjaxVersion", m.group(1) == want,
          "the installer downloads %r, fetch-libs.ps1 fetches %r"
          % (m.group(1), want))

    # The URL must be *built from* the define, not hand-written: a literal
    # version in TikzjaxUrl would make the define above decorative.
    url = re.search(r'#define\s+TikzjaxUrl\s+"?(.*)', iss_src)
    check("installer: TikzjaxUrl is built from TikzjaxVersion",
          bool(url) and "TikzjaxVersion" in url.group(1),
          "TikzjaxUrl does not interpolate the define")
    # TikzjaxSha256 is intentionally NOT verified: doing so needs the network.


# ---- 5. build.ps1's $libsSentinels --------------------------------------
def dest_groups(fetch_src):
    """assets/libs/<group> trees fetch-libs.ps1 populates.

    `group` is the first path segment: a top-level directory per library, or the
    bare filename for the libraries that are one file (marked.min.js). Anything
    deeper (katex/fonts/, abcjs/soundfont/) belongs to its library rather than
    being one -- the sound bank's own sentinel is asserted separately below,
    since it is a 2MB opt-in download that can be absent on its own.
    """
    # Drop whole-line comments first: the download table is introduced by a
    # `# Each entry: @{ Url = '...'; Dest = '<relative to LibsDir>' }` line that
    # would otherwise register as a library called `<relative to LibsDir>`.
    fetch_src = "\n".join(
        ln for ln in fetch_src.splitlines() if not ln.lstrip().startswith("#"))
    groups = set()
    for _, dest in re.findall(r"Dest\s*=\s*(['\"])([^'\"]+)\1", fetch_src):
        groups.add(dest.replace("\\", "/").split("/")[0])
    # tikzjax arrives as an extracted npm tarball, not through $Downloads.
    for _, path in re.findall(r"Join-Path \$LibsDir (['\"])([^'\"]+)\1", fetch_src):
        groups.add(path.replace("\\", "/").split("/")[0])
    return groups


def check_sentinels(fetch_src, build_src):
    region = slice_array(build_src, "$libsSentinels = @(", BUILD_PS1)
    sentinels = [s.replace("\\", "/") for s in re.findall(r"'([^']+)'", region)]
    check("build.ps1: $libsSentinels parsed", bool(sentinels),
          "no quoted entries in the array")

    stray = [s for s in sentinels if not s.startswith("libs/")]
    check("build.ps1: every sentinel is under libs/", not stray,
          "outside assets/libs/: %s" % ", ".join(stray))
    rel = [s[len("libs/"):] for s in sentinels if s.startswith("libs/")]

    covered = set(r.split("/")[0] for r in rel)
    fetched = dest_groups(fetch_src)
    bundles = bundle_groups()

    for group in sorted(fetched):
        check("build.ps1: sentinel for %s" % group, group in covered,
              "fetch-libs.ps1 populates assets/libs/%s but build.ps1 has no "
              "sentinel for it -- an existing checkout will never re-fetch it "
              "and the built tree 404s" % group)

    for group in sorted(covered):
        check("build.ps1: sentinel group %s is still fetched" % group,
              group in fetched or group in bundles,
              "nothing fetches or builds assets/libs/%s any more -- a stale "
              "sentinel makes install-deps.ps1 run on every build" % group)

    # The sound bank is its own completeness marker: 88 MP3s fetched one by one,
    # and fetch-libs.ps1 SKIPS files that already exist, so only the note fetched
    # LAST means "all 88 are there".
    notes = re.findall(r"\$AbcSoundfontNotes\s*\+=\s*'([^']+)'", fetch_src)
    sf = [r for r in rel if r.startswith("abcjs/soundfont/")]
    check("build.ps1: sentinel for the abcjs sound bank", bool(sf),
          "the 88 note MP3s are an independently skippable download set")
    if sf and notes:
        last = notes[-1]
        check("build.ps1: sound-bank sentinel is the note fetched last",
              all(os.path.basename(s) == last + ".mp3" for s in sf),
              "fetch-libs.ps1 fetches %s.mp3 last; the sentinel names %s"
              % (last, ", ".join(os.path.basename(s) for s in sf)))


def main():
    argparse.ArgumentParser(description=__doc__.splitlines()[0]).parse_args()

    pins = fetch_pins(read(FETCH_LIBS))
    check("fetch-libs.ps1: version pins found", bool(pins),
          "no $<Name>Version = '...' lines -- the pin block moved")
    for var, version in sorted(pins.items()):
        print("     $%-20s = %s" % (var, version))

    check_licenses(pins, read(COLLECT_LIC))
    check_export_cdn(pins, read(APP_HTML))
    check_installer(pins, read(INSTALLER_ISS))
    check_sentinels(read(FETCH_LIBS), read(BUILD_PS1))

    print("\n%d FAILED" % fail if fail else "\nall version pins agree")
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    main()
