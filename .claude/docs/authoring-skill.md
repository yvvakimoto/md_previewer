# The bundled Claude authoring skill

**Owns:** `.claude/skills/md-previewer-author/**` and the `claudeskill` lines in `installer/md-previewer.iss`
**Read before:** editing the skill, changing what the installer ships to the user's `.claude`, or adding a feature the skill should teach.
**Related:** build-and-deps.md (the rest of the installer), harness-testing.md (owns `skillcheck.py`, which enforces what is below), release.md

---

## What it is

`.claude/skills/md-previewer-author/` is a Claude Code skill that writes `.md`
documents and Marp decks *for this previewer* — it decides between portable
Markdown and the previewer's extensions, then writes the file and (for decks)
verifies the layout with `--export-png` / `shoot.py`.

It is **a shipped artifact, not a repo-only convenience**: from the installer's
`claudeskill` task it lands in the user's personal skills directory, where Claude
Code picks it up for every project.

```
SKILL.md                  the skill itself (frontmatter name + description, 3 steps)
references/features.md    normal-pipeline syntax, one section per feature
references/marp-slides.md deck authoring
samples/                  snapshot of the repo's samples/ (see "The samples split")
package.ps1               builds <name>.skill (a ZIP) for manual distribution
```

## How the installer ships it

`installer/md-previewer.iss`:

- **`[Tasks]` `claudeskill`, `Flags: unchecked`.** ⚠ It must stay opt-in: it
  writes outside `{app}`, into a directory that belongs to the user's Claude
  setup, so it can never be a silent default. `skillcheck.py` fails if the flag
  disappears.
- **`[Files]` → `{userprofile}\.claude\skills\md-previewer-author`.** Three
  entries, all `Tasks: claudeskill`, so an unchecked install writes nothing at
  all. No `[Code]` is involved — this is plain file copying, which means the
  files are in the uninstall log and go away on uninstall.
- The skill root is **enumerated file by file, never wildcarded**: `package.ps1`
  is a dev tool and `*.skill` is a git-ignored build artifact, and neither
  belongs in a user's skills folder.
- **`[UninstallDelete]`** removes `samples\` wholesale (it has nested
  subdirectories the log-driven delete leaves behind) and then the two now-empty
  directories. ⚠ Never touch `{userprofile}\.claude\skills` itself — other
  people's skills live there.

### Behaviour on update, and the one wart

`[Setup]` does not set `UsePreviousTasks`, so it defaults to `yes`, and
`src/updater.rs` launches the installer with
`/VERYSILENT /SUPPRESSMSGBOXES /NORESTART` — which does not override task
selection. Net effect, and it is the desirable one:

- a user who ticked the box gets the skill **refreshed on every app update**;
- a user who did not never receives it.

⚠ The wart: unticking the box on a later install does **not** remove an
already-installed skill (Inno deletes on uninstall, not on task deselection).
Say so in the README rather than adding `[Code]` to work around it.

## The samples split — why there are two copies

`SKILL.md` promises worked examples under `samples/` with skill-relative paths,
so the skill has to carry its own copy to work outside this repo. That is a
mirror, and this one had already gone twelve files stale before anyone looked.

The split that resolves it:

| Copy | Source of truth at | Kept honest by |
|---|---|---|
| what the **installer** ships | install time — `[Files]` sources `..\samples\*` directly | structurally impossible to be stale |
| what a **`.skill` archive** ships | package time — `package.ps1` refreshes from `..\..\..\samples` | `-NoRefreshSamples` opts out |
| the **committed snapshot** | commit time — a human runs the refresh | `skillcheck.py` (hard fail) |

So the installer never reads the committed snapshot. The snapshot exists for
repo-external use and as the packager's input, and drift in it is a check
failure, not a surprise in a release.

⚠ `package.ps1` excludes `*.skill`. Without that line the packager zips the
*previous* archive into the new one — that shipped once, at 3× the size.

## Keeping the reference docs current

`references/features.md` is the model's syntax authority. A new figure fence or
Markdown extension is not done until it has a section there — the same rule as
`samples/` (CLAUDE.md 27). `skillcheck.py` warns (not fails) when an engine named
in CLAUDE.md's figure-fence row is absent from `features.md`; warn-only because a
feature commit may legitimately precede its authoring guidance, but it must not
do so silently.

Two content rules the skill's own text has to respect:

- The frontmatter `description` is validated by `package.ps1` — ≤ 1024 chars and
  no angle brackets. It is also what makes the skill trigger, so keep the feature
  nouns in it.
- Anything documented as *document content* (a `watermark:` value, for instance)
  must be flagged as untranslatable in `features.md`, mirroring CLAUDE.md 15.

## Commands

```powershell
python tools/preview-harness/skillcheck.py                        # snapshot + refs + installer wiring
pwsh -File .claude/skills/md-previewer-author/package.ps1         # -> .\md-previewer-author.skill
pwsh -File .claude/skills/md-previewer-author/package.ps1 -OutputDir $env:TEMP\skillpkg
```

`*.skill` is git-ignored (`.gitignore`), so a packaged archive never lands in a
commit. Refreshing the committed snapshot is a side effect of running
`package.ps1` in the repo — review that diff before committing it.
