# Release automation

**Owns:** `tools/release-on-main.ps1`, `tools/hooks/post-merge`, `build-installer.ps1`, `HISTORY.md`
**Read before:** cutting a release, or changing the version-bump / notes flow.
**Related:** build-and-deps.md (the installer it builds), auto-update.md

> Relocated verbatim from `CLAUDE.md`. Invariants that apply everywhere stay in
> `CLAUDE.md`; this file holds the detail for the files listed above.

---

### Release automation (`main`-branch git hook)

Releases are automated by a tracked git hook that fires when the **`main`** branch is updated via a merge (`git merge` / `git pull`). The pieces:

- `tools/hooks/post-merge` — tiny POSIX-`sh` shim (Git for Windows runs hooks via its bundled `sh`). It only invokes `pwsh -NoProfile -File tools/release-on-main.ps1`, and short-circuits if `MDP_IN_RELEASE=1` is already set (re-entrancy guard). It always `exit 0`s so a failed release never blocks the merge.
- `tools/release-on-main.ps1` — the orchestrator, split into **two phases** so the release notes cannot be published unreviewed. It finds the previous release tag via `git describe --tags --abbrev=0 --match "v*"`, collects `git log --no-merges` subjects in `<lastTag>..HEAD`, and **exits silently when that range is empty** (so it never re-fires after its own release commit — the new tag sits at HEAD).

  **Phase 1 (default, what the hook runs)** — rewrites the version in **three places** (`Cargo.toml` `version =`, `installer/md-previewer.iss` `#define AppVersion`, and a new `## v<X.Y.Z>` section prepended to `HISTORY.md`) and then **stops**. No build, no commit, no tag. The generated section carries a `TODO(release-notes)` review marker.
  - **Commit classification.** Subjects are split by Conventional-Commit prefix: `feat:`/`fix:`/`perf:` and un-prefixed free-form subjects become **user-facing bullet candidates** (prefix stripped, so they read sensibly even unedited); `refactor:`/`test:`/`docs:`/`chore:`/`build:`/`ci:`/`style:` become **internal work**, listed inside the review comment as reference rather than as shippable bullets. The skip regex (this script's own `リリース v…` commits, `WIP`, `Merge`, …) is **anchored at the start** of the subject — it used to match `version`/`release` anywhere, which could silently drop a legitimate `feat: リリースノート生成に対応`.
  - **Bump heuristic.** Breaking (`破壊的`/`BREAKING`/`!:`) → major; a **user-facing** subject matching `追加`/`機能`/`対応`/`実装`/`新規`/`^feat` → minor; else patch. Internal commits no longer count toward minor — a refactor- or docs-only range is now correctly a patch. Override with `-Bump major|minor|patch`.
  - **`## 未リリース` folding.** A hand-written `## 未リリース` (or `Unreleased`) section is absorbed: its bullets are carried into the new version section *first*, and the heading is removed. Without this the script's insertion point (the first `^## v`) leaves that section stranded above the release with duplicate content.
  - **Re-run guard.** If a draft is still pending (marker present), phase 1 refuses — **even with `-Force`** — so the version can never be double-bumped. `-Force` means "I know the tree is dirty", not "bump me twice".

  **Phase 2 (`-Finalize`)** — refuses while the review marker or a `## 未リリース` heading remains, checks the three version sites agree and that the tag doesn't already exist, **then** runs `build-installer.ps1` (with `MDP_IN_RELEASE=1`) and, only on a successful build, stages just those files, commits `リリース v<X.Y.Z>`, and `git tag v<X.Y.Z>` — an ordinary commit (fires `post-commit`, not `post-merge`, so no loop). Building here rather than in phase 1 is the point: `installer/md-previewer.iss` bundles `HISTORY.md` and auto-opens it after install, so an installer built before the notes were edited would ship the raw draft.

  **`-Verify`** — mechanical pre-publish check, runnable any time: the three version sites agree, `## v<X.Y.Z>` exists, no review marker, no leftover `## 未リリース`, the tag is HEAD or an ancestor, and **the release notes bundled into the installer match the current `HISTORY.md`**. That last one compares a SHA-256 recorded by `build-installer.ps1` (`dist/…exe.notes.sha256`) rather than timestamps, so a `git checkout` that rewrites `HISTORY.md` byte-identically doesn't raise a false alarm; artifacts predating the stamp fall back to an mtime comparison.

  **`-Publish`** — after the tag is pushed, creates the GitHub Release and attaches the installer via the `gh` CLI, taking the body from `HISTORY.md`'s section for that version. Separate from `-Finalize` on purpose: `gh release create` invents the tag from the default branch when it is missing on the remote, so this step requires the tag to already be on `origin`.

  Push is never automatic unless `MDP_RELEASE_PUSH=1`. Other flags: `-DryRun` (phase-1 report, or `-Publish` preview), `-SkipBuild` (`-Finalize` without the installer build), `-Force` (also "overwrite the existing release" under `-Publish`).
- `tools/install-hooks.ps1` — sets `git config core.hooksPath tools/hooks`. This is **per-clone local config**, so it must run once after cloning; `install-deps.ps1` calls it automatically (right after `fetch-libs.ps1`, so even `-SkipNode` enables the hook).

#### The release flow in practice — merge, review, finalize

`HISTORY.md` is bundled into the installer and **auto-opened after install**, so a generated draft must never reach a user. The script therefore refuses to finalize while the draft is unreviewed; the steps below are what that gate expects, not a checklist you have to remember.

**1. (optional) Preview before merging.** Cheapest place to catch a wrong bump, since the version lands in three files:

```bash
pwsh -NoProfile -File tools/release-on-main.ps1 -DryRun -Force
```

**2. Merge into `main`.** The hook runs phase 1: versions bumped, a `## v<X.Y.Z>` draft written to `HISTORY.md`, nothing built, committed or tagged. It prints the next command. If the bump is wrong, discard and redo with `-Bump`:

```bash
git checkout -- Cargo.toml installer/md-previewer.iss HISTORY.md
pwsh -NoProfile -File tools/release-on-main.ps1 -Bump patch
```

**3. Write the release notes.** Open the `## v<X.Y.Z>` section. The draft gives you user-facing candidates as bullets and the internal commits as reference inside the `TODO(release-notes)` comment. Turn it into something a user benefits from reading:

- **Delete what a user cannot observe.** A range that was entirely internal gets one honest line — 「内部改善（動作の変更はありません）」— not fifteen `refactor:` bullets. Phase 1 already pre-fills exactly that when it finds no user-facing commits.
- **Describe the change, not the implementation.** Lead with a bold feature name, then what changed for the reader: 「**定義リストに対応** — `用語` の次の行に `: 説明` と書くと…」. Keep the `- **名前** — 説明。` shape and newest-first ordering used throughout the file.
- **Merge several commits that were one feature** into one bullet, and drop anything added and then reverted inside the same range.
- **Check the internal list for buried user-facing fixes.** Prefix-based classification is a heuristic: in v0.18.0 a workspace `_toc.md` bug fix sat under a `test:` commit and would have been dropped on prefix alone.
- Optionally summarize the internal work as a single `> 開発者向け:` line (v0.15.0 and v0.18.0 do this).

Then **delete the `TODO(release-notes)` comment block**.

**4. Finalize.** This is the gate: it refuses while the marker (or a leftover `## 未リリース` heading) remains, verifies the three version sites agree and the tag is free, then builds the installer — with your edited notes inside it — and creates the commit and tag:

```bash
pwsh -NoProfile -File tools/release-on-main.ps1 -Finalize
```

**5. Verify and publish.**

```bash
pwsh -NoProfile -File tools/release-on-main.ps1 -Verify
git push origin main && git push origin v0.18.0
```

`-Verify` is mechanical and re-runnable; it also catches the case where you edited `HISTORY.md` *after* finalizing, which leaves the built installer bundling stale notes (it compares the notes hash `build-installer.ps1` recorded at build time). If it reports that, rebuild and amend:

```bash
pwsh -NoProfile -File build-installer.ps1 -SkipBuild -SkipLicenses
git add HISTORY.md && git commit --amend --no-edit && git tag -f v0.18.0
```

(`git tag -f` is required — the tag still points at the pre-amend commit otherwise.)

**6. Create the GitHub Release.** The installer is distributed as a release asset (`dist/` is git-ignored), and the landing page's download button points at `releases/latest`, so a tag with no release means the page keeps offering the previous version.

```bash
pwsh -NoProfile -File tools/release-on-main.ps1 -Publish
```

`-Publish` needs the [GitHub CLI](https://cli.github.com/) (`winget install --id GitHub.cli`, then `gh auth login`). It reads the version from `Cargo.toml`, takes the release body from `HISTORY.md`'s `## v<X.Y.Z>` section verbatim, and attaches `dist/MdPreviewer-Setup-<ver>.exe`. Add `-DryRun` to see the command and the body without publishing.

Four things it refuses on, each because publishing anyway would be worse than stopping:

- **The tag is not on `origin`.** `gh release create` would then *create* the tag from the default branch's HEAD, quietly publishing something other than what was tagged. This is the reason `-Publish` is a separate step after `git push` rather than part of `-Finalize`.
- **The bundled release notes are stale** (same hash check as `-Verify`) — the artifact would ship a `HISTORY.md` that doesn't match the notes on the release page.
- **The review marker is still in `HISTORY.md`** — it would become the release body.
- **The release already exists.** `-Force` then re-uploads the asset with `--clobber` and rewrites the body.

The `.notes.sha256` stamp is deliberately **not** attached — it is an internal build stamp that only `-Verify` reads, and it is noise next to the installer on a public release page. (v0.30.0 has one because that release was created by hand.)

⚠ **The notes hash is taken over LF-normalized content, not raw bytes.** This clone has `core.autocrlf=true`, so git rewrites `HISTORY.md` with CRLF on checkout while `release-on-main.ps1` writes it with LF — a raw-byte hash then differs for a file whose content never changed, and `-Verify` reported the bundled notes as stale on a perfectly good release (measured on v0.30.0: stamp `2DDC…`, working tree `ED14…`). `Get-NotesHash` normalizes first; it is a **mirror implementation** in `build-installer.ps1` (which writes the stamp) and `release-on-main.ps1` (which checks it), so the two must stay in sync. Same rule `tools/preview-harness/tablecheck.py` already applies to its payload comparisons.

**If the installer build fails during `-Finalize`**, there is no commit and no tag and the version edits stay in the working tree. Fix the build and re-run `-Finalize`; do not hand-commit.
