#!/usr/bin/env python
"""Keep the shipped Claude authoring skill in sync with the repo.

    python tools/preview-harness/skillcheck.py [--strict]

`.claude/skills/md-previewer-author/` is no longer a repo-only convenience: the
installer ships it as an optional component (task `claudeskill`, OFF by default,
installed into `%USERPROFILE%\\.claude\\skills\\`). That makes its content a
release artifact, and release artifacts go stale silently.

They already had. Before this check existed the committed `samples/` snapshot was
twelve files and several revisions behind the repo's `samples/`, and
`references/features.md` documented none of markwhen / tikz / kataskeve /
feynman / definition lists.

STDLIB ONLY -- no Playwright, no Chromium, well under a second. `docskeycheck.py`
is the precedent and the reason: a check this cheap can sit in a pre-commit hook
and runs on a machine with no browser.

WHAT IS CHECKED

1. The skill's `samples/` snapshot equals the repo's `samples/`, file set and
   bytes. FAIL. Note the INSTALLER does not use this snapshot -- `[Files]`
   sources `..\\samples\\*` straight into the installed skill so the shipped copy
   cannot be stale. The snapshot is for repo-external use and for `package.ps1`,
   and this is what keeps it honest.
2. Every `samples/...` path named by `SKILL.md` or `references/*.md` exists.
   FAIL -- the skill tells the model to go read those files.
3. The installer wiring is still present and still opt-in: the `claudeskill`
   task with `Flags: unchecked`, the three `[Files]` lines, the
   `[UninstallDelete]` entry, and `package.ps1` excluding `*.skill` (without it
   the packager zips the previous archive into the new one). FAIL.
4. Every figure-fence engine listed in CLAUDE.md's feature table appears in
   `references/features.md`. WARN only -- a new engine may legitimately land a
   commit before its authoring guidance does, but it must not land silently.
   `shoot-docs.py`'s warn-only GALLERY check is the precedent.
"""

import argparse
import os
import re
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

SKILL_DIR = os.path.join(REPO_ROOT, ".claude", "skills", "md-previewer-author")
SKILL_SAMPLES = os.path.join(SKILL_DIR, "samples")
REPO_SAMPLES = os.path.join(REPO_ROOT, "samples")
SKILL_MD = os.path.join(SKILL_DIR, "SKILL.md")
REFERENCES = os.path.join(SKILL_DIR, "references")
FEATURES_MD = os.path.join(REFERENCES, "features.md")
ISS = os.path.join(REPO_ROOT, "installer", "md-previewer.iss")
PACKAGE_PS1 = os.path.join(SKILL_DIR, "package.ps1")
CLAUDE_MD = os.path.join(REPO_ROOT, "CLAUDE.md")

warnings = []


def read(path):
    with open(path, "rb") as fh:
        return fh.read()


def read_text(path):
    return read(path).decode("utf-8", "replace")


def tree(root):
    """{relative posix path: bytes} for every file under root."""
    out = {}
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace("\\", "/")
            out[rel] = full
    return out


def check_samples_snapshot():
    if not os.path.isdir(SKILL_SAMPLES):
        print("FAIL: the skill has no samples/ snapshot at %s" % SKILL_SAMPLES)
        return 1
    theirs = tree(SKILL_SAMPLES)
    ours = tree(REPO_SAMPLES)

    missing = sorted(set(ours) - set(theirs))
    extra = sorted(set(theirs) - set(ours))
    differing = sorted(rel for rel in set(ours) & set(theirs)
                       if read(ours[rel]) != read(theirs[rel]))

    fail = 0
    for rel in missing:
        print("FAIL: samples/%s is in the repo but missing from the skill snapshot" % rel)
        fail += 1
    for rel in extra:
        print("FAIL: the skill snapshot carries samples/%s, which the repo does not have" % rel)
        fail += 1
    for rel in differing:
        print("FAIL: samples/%s differs between the repo and the skill snapshot" % rel)
        fail += 1
    if fail:
        print("      -> refresh it: pwsh -File .claude/skills/md-previewer-author/package.ps1")
    return fail


SAMPLE_REF = re.compile(r"samples/[^\s`'\"()\[\],;]+")


def check_sample_references():
    fail = 0
    docs = [SKILL_MD]
    if os.path.isdir(REFERENCES):
        docs += [os.path.join(REFERENCES, n) for n in sorted(os.listdir(REFERENCES))
                 if n.endswith(".md")]
    for doc in docs:
        text = read_text(doc)
        for ref in sorted(set(SAMPLE_REF.findall(text))):
            rel = ref.rstrip("/.:,")
            target = os.path.join(REPO_ROOT, rel.replace("/", os.sep))
            if not os.path.exists(target):
                print("FAIL: %s references %s, which does not exist"
                      % (os.path.relpath(doc, REPO_ROOT).replace("\\", "/"), rel))
                fail += 1
    return fail


ISS_REQUIRED = [
    ('Name: "claudeskill"', "the [Tasks] entry"),
    ("Flags: unchecked", "the task must stay OFF by default"),
    (r'Source: "..\.claude\skills\md-previewer-author\SKILL.md"', "SKILL.md [Files] line"),
    (r'Source: "..\.claude\skills\md-previewer-author\references\*"', "references [Files] line"),
    (r'DestDir: "{%USERPROFILE}\.claude\skills\md-previewer-author\samples"',
     "samples sourced from the repo's samples/"),
    (r'Type: filesandordirs; Name: "{%USERPROFILE}\.claude\skills\md-previewer-author\samples"',
     "the [UninstallDelete] entry"),
]


def check_installer():
    fail = 0
    iss = read_text(ISS)
    for needle, what in ISS_REQUIRED:
        if needle not in iss:
            print("FAIL: installer/md-previewer.iss is missing %s (%r)" % (what, needle))
            fail += 1
    # The claudeskill task itself must carry Flags: unchecked -- a bare
    # "Flags: unchecked" anywhere else (desktopicon) must not satisfy the check.
    for line in iss.splitlines():
        if line.startswith('Name: "claudeskill"') and "Flags: unchecked" not in line:
            print("FAIL: the claudeskill task lost 'Flags: unchecked' -- it must be opt-in")
            fail += 1
    ps1 = read_text(PACKAGE_PS1)
    if "'*.skill'" not in ps1 and '"*.skill"' not in ps1:
        print("FAIL: package.ps1 no longer excludes *.skill -- it will pack the "
              "previous archive into the new one")
        fail += 1
    return fail


# The engines live in the row's FIRST cell, so this deliberately spans the whole
# row and drops the trailing `<doc>.md` cell by filtering dotted tokens below.
FENCE_ROW = re.compile(r"^\|\s*Diagram / figure fences(.*)$", re.M)


def check_engine_coverage():
    claude_md = read_text(CLAUDE_MD)
    m = FENCE_ROW.search(claude_md)
    if not m:
        warnings.append("CLAUDE.md has no 'Diagram / figure fences' row -- engine "
                        "coverage not checked")
        return
    engines = set()
    for token in re.findall(r"`([^`]+)`", m.group(1)):
        for part in token.split("/"):
            part = part.strip()
            if part and re.match(r"^[a-z0-9]+$", part):
                engines.add(part)
    features = read_text(FEATURES_MD)
    for engine in sorted(engines):
        if not re.search(r"\b%s\b" % re.escape(engine), features):
            warnings.append("references/features.md never mentions the `%s` fence" % engine)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--strict", action="store_true",
                    help="treat coverage warnings as failures too")
    args = ap.parse_args()

    fail = check_samples_snapshot()
    fail += check_sample_references()
    fail += check_installer()
    check_engine_coverage()

    for w in warnings:
        sys.stderr.write("WARN: %s\n" % w)
    if args.strict:
        fail += len(warnings)

    print("\n%d FAILED" % fail if fail else "\nall skill checks passed")
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    main()
