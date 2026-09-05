# Auto-update

**Owns:** `src/updater.rs`, `src/http_win.rs`, `assets/update.json`, `assets/update.example.json`, the `#update-banner` in `assets/index.html`
**Read before:** changing the update check, the transport, the banner, or the install flow.
**Related:** rust-host.md, release.md (the `-Publish` step that feeds the GitHub provider)

---

## Two providers, one flow

Check → notify → download → silent install → relaunch. Both providers share every
step; they differ only in where the new version comes from.

| | `github` (default) | `share` |
|---|---|---|
| Source | this repo's Releases feed | a directory on a file share (UNC or local) |
| Transport | HTTPS via `src/http_win.rs` (WinHTTP) | `std::fs` |
| Manifest | `https://api.github.com/repos/<repo>/releases/latest` | `<source>/<manifest>` (`latest.json`) |
| Installer | the release's `MdPreviewer-Setup-*.exe` asset | `<source>/<manifest.setup>` |
| Launchable before the download? | **no** (see the `as_ready()` split below) | yes |
| Rate limited? | yes — hence the check throttle | no |

**Nothing on the publishing side had to change.** `tools/release-on-main.ps1 -Publish`
already runs `gh release create <tag> dist\MdPreviewer-Setup-<ver>.exe --notes-file …`
with the `HISTORY.md` section as the body, so the GitHub provider reads a feed the
existing release flow fills in.

## Config

`updater::load_config()` looks for `update.json` **next to the exe first, then in
`assets/`**. Absent / `enabled:false` / missing the field its provider needs /
malformed ⇒ `None` ⇒ no thread, no network.

```json
{ "enabled": true, "provider": "github", "repo": "owner/name",
  "timeoutMs": 8000, "minCheckIntervalMinutes": 360 }
```

- **`assets/update.json` ships with the app** and selects `github`, so the feature is
  **on by default**. Deleting that file, or setting `enabled:false`, turns it off.
  A unit test (`shipped_update_json_selects_github`) pins that the shipped file really
  does load, is enabled, and resolves to GitHub — the whole default rests on it.
- **The offline-first guarantee is about *viewing*.** Rendering a document still pulls
  nothing from the network; the update check is deliberately outside that promise.
  Say it that way in user-facing text — `README.md` used to claim the app never
  contacts the internet at all, which this contradicts.
- ⚠ **`provider` is inferred when absent**, and that branch is a *compatibility
  guarantee*, not a convenience: `update.json` files already deployed inside
  organisations predate the key and carry only `source`. A non-empty `source` with no
  explicit `provider` therefore means `share`; anything else (including a bare
  `{"enabled":true}`) means `github`. `provider_resolution` covers all six cases.
- ⚠ **An intranet distributor should place `update.json` next to the exe, not in
  `assets/`.** The installer copies `..\assets\*` with `ignoreversion`, so an overlay
  in `assets/` is reverted to the GitHub default by the next upgrade; `{app}\update.json`
  is not touched and also wins the lookup. `assets/update.example.json` is the
  `provider: "share"` template and says so.
- `timeoutMs` is `Option<u64>`: absent ⇒ 4000 for `share`, **8000 for `github`**
  (HTTPS pays for DNS plus a TLS handshake before the first byte). Resolved by
  `effective_timeout_ms`, so serde never has to distinguish absent from explicit.

## `src/http_win.rs` — why WinHTTP

No new crate: `windows 0.39` was already pinned for `webview2-com`, and only the
`Win32_Networking_WinHttp` feature had to be switched on (features are additive, so
this cannot take anything away from wry — but ⚠ the **0.39 pin must not be raised**,
it exists so `WebViewExtWindows::controller()`'s `ICoreWebView2` matches `pdf_win.rs`).

More importantly the OS then owns what an organisation cares about: TLS, the **Windows
certificate store** (a corporate MITM proxy's root is trusted like any other app's),
and **proxy auto-discovery** via `WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY` (WPAD, then the
IE/system settings). A bundled-roots client such as rustls would fail on exactly the
intranet machines this feature is for.

Two functions, `get()` (into memory) and `download()` (streamed to a file). Notes:

- Handles are wrapped in an RAII `Handle` — the happy path is three nested handles with
  a fallible step between each, and hand-closing meant a `WinHttpCloseHandle` before
  every early return.
- `crack_url()` uses `WinHttpCrackUrl` rather than hand-parsing, and is the one part
  pure enough to unit-test without a network (five tests).
- Redirects are followed by default; the asset download needs it
  (`github.com` → `objects.githubusercontent.com`). Non-https is refused outright.
- 403/429 is logged as **`(rate limited?)`** — otherwise it is indistinguishable in the
  log from "no update", which is the failure the throttle below exists to prevent.
- Every response is capped (`MANIFEST_MAX_BYTES` 2 MB, `INSTALLER_MAX_BYTES` 200 MB),
  enforced *during* the read.

## The check throttle

⚠ Unauthenticated GitHub API requests are limited to **60 per hour per IP**, and a whole
office sits behind one NAT address. Without a throttle an organisation of any size burns
the budget and every further check 403s — i.e. update notifications simply stop
appearing, with nothing to distinguish that from being up to date.

`%TEMP%\mdp-update\last-check` holds a unix timestamp; `should_check(now, last,
interval)` is pure and unit-tested. Permissive at the edges on purpose — no stamp, a
zero interval, or a clock that went backwards all mean "check", because being locked out
by a bad stamp is worse than one extra request.

**The stamp is written after every attempt, success or failure.** A 403 is exactly what
the throttle protects against, and a transport failure means the machine is offline,
where retrying every launch buys nothing and only repeats the timeout. The cost is that
connectivity returning mid-interval is noticed up to `minCheckIntervalMinutes` late,
which is acceptable for a background notification. **Testing note:** delete the stamp
between runs, or the check you are trying to observe is skipped.

*Escape hatch if the limit ever bites anyway:* `https://github.com/<slug>/releases/latest`
302s to `…/releases/tag/vX.Y.Z` with no rate limit at all, and the asset name is a fixed
convention — detection could move there, with the API called only once an update is
actually found. Not done, because it is two code paths for one answer.

## Trigger — content first, and nothing runs at startup

`main()` only records `is_capture` plus owned `upd_exe_dir` / `upd_assets_dir`; the
worker is spawned from the **`CustomEvent::StartUpdateCheck`** arm, fed by whichever of
two triggers arrives first:

- the preview's **`renderdone:` IPC** — the normal path. `__emitRenderDone` posts on an
  80 ms `setTimeout` (a macrotask) while `loadFileFromRust`'s `await renderMarkdown(...)`
  resumes on a microtask, so the `#app-container` reveal + `hideSplash()` have already
  run: the signal means *the document is on screen*. It also fires from the
  render-failure `catch`, so a broken document does not wait the watchdog out.
- a **watchdog** (`UPDATE_WATCHDOG_MS`, 5 s), spawned right after
  `webview_builder.build()`, for a page that never reports render-done — a JS error, a
  hung render, or a launch with no file at all (the drop zone renders nothing). Timed
  from the webview's creation. Skipped entirely in capture mode.

Idempotency is a plain `let mut update_check_started: bool` owned by the event loop —
both triggers funnel through that one single-threaded arm, so no `AtomicBool` / `Once`
is needed. The arm itself does no I/O and takes no `webview` lock.

This shape exists because the check used to run from `main()` before
`WebViewBuilder::build()`: `load_config()` did two untimed `fs::read` on the main thread
ahead of first paint, and the worker's I/O competed with webview creation and with the
`app://` reads for the very document the user was waiting on. Measured against an
unreachable share that was ~2.3 s of failure landing squarely on startup.

## Two phases, so the banner is never gated behind the download

The worker runs: (1) `load_config()`; (2) **`check_manifest()`** — dispatches on the
provider, one timed read plus a semver compare (`parse_semver`/`is_newer`, tolerant
tuple compare; parse failure ⇒ "not newer"), returning an `UpdateFound`; (3) publishes
`found.as_ready()` and posts `CustomEvent::UpdateAvailable` **immediately**; (4)
**`prefetch_installer()`** brings the installer into `%TEMP%\mdp-update\`.

`check_manifest` was split from the download because it used to finish an **untimed
multi-MB `fs::copy`** before returning. **`banner dispatched` preceding `prefetched` in
`md-previewer.log` is the invariant this split exists for**, and it holds for both
providers — measured on the GitHub path at 1.6 s vs 2.5 s for the 7.6 MB asset.

The transfer goes to a `.part` file and is `rename`d into place: publishing an
installable handle before the copy widens the window in which a second instance could
observe a half-written `%TEMP%` file, and `fs::rename` replaces atomically on Windows.
The GitHub path additionally **compares the byte count against the asset `size`** from
the release metadata — the only integrity signal GitHub offers, and it catches a
truncated transfer that would otherwise reach the user as an installer that dies halfway
through replacing their app.

### ⚠ `as_ready()` is `Option`, and that is the whole GitHub-specific complication

A share path is launchable the moment the banner appears — it has always been the
prefetch-failure fallback, so a click landing mid-copy is merely slower, never broken.
**An `https://` asset is not a file until it is downloaded**, so `as_ready()` returns
`None` for GitHub and `update_ready` stays `None` for the first seconds the banner is up.

`src/main.rs` covers that window with two flags declared next to `update_ready`:

- **`update_fetching`** — the download is still running, so a click can *wait* rather
  than be told "no".
- **`install_when_ready`** — a click that arrived during it, which the prefetch worker
  honours as soon as it has a path.

⚠ **Both are read under the `update_ready` lock, always taken first**, in the IPC arm and
in the worker alike. Without that consistent order a click landing exactly as the worker
publishes could observe "not ready" and "not fetching" from opposite sides of the
update and wrongly report failure.

The resulting `update:install` behaviour is a three-way match:

| `update_ready` | `update_fetching` | what happens |
|---|---|---|
| `Some` | – | launch + relaunch + `QuitForUpdate` (the original path) |
| `None` | true | reserve, post `UpdateInstallPending` → button reads 「ダウンロード中…」 |
| `None` | false | the download already failed ⇒ `UpdateInstallFailed` |

and the worker, once the prefetch settles, either honours the reservation (launch +
`QuitForUpdate`) or posts `UpdateInstallFailed`. Failure is soft for a share — the
published share path still installs — but terminal for GitHub, where there is no
fallback; either way it only becomes the reader's problem if they are waiting on it.

## Logging

**Timestamped** (`[+   707ms] …`), because a 「起動が止まる」 report is about *gaps*, not
ordering. Nothing parses `md-previewer.log`, so the format is ours. A healthy GitHub run
reads:

```
[+   832ms] updater: check triggered by renderdone
[+   839ms] updater: enabled via "…\assets\update.json" (provider=github, repo=…)
[+  1602ms] updater: update available 0.1.0 -> 0.33.0 (MdPreviewer-Setup-0.33.0.exe, 7596206 bytes)
[+  1603ms] updater: banner dispatched (version=0.33.0)
[+  1609ms] [js] update banner shown v0.33.0
[+  2464ms] updater: prefetched 7596206 bytes to "…\mdp-update\MdPreviewer-Setup-0.33.0.exe"
```

or, when up to date, `updater: up to date (latest=0.33.0, current=0.33.0)`; when
throttled, `updater: skipped, checked 241s ago (minCheckIntervalMinutes=360)`.

The banner reports back over the existing `__dbgLog` (`/__log/`) bridge:
`update banner shown v<ver>` / `update banner deferred (dom not ready)` /
`update banner suppressed by optout` / `update deferred to exit` /
`update install waiting for download` / `update install failed`. Before these the log
stopped at `prefetched` and could not distinguish "shown", "user opted out" and
"silently dropped" — which is why the load race below went unnoticed.

## UX — notify, then update

`UpdateAvailable` calls `window.__updateAvailable({version, notes})`, which shows
**`#update-banner`**: a small **bottom-right card**, not a full-width top bar — an update
is 「気づけばよい」 information, so it must not cover the first lines of the document nor
carry modal-like weight. It reuses the help/style modal's `.panel` palette so it reads as
native chrome, and carries two update buttons — a filled primary **「今すぐ更新」**
(`update-install-btn`) and an outline secondary **「終了後に更新」**
(`update-onexit-btn`), which differ only in *when* the install runs — plus an
absolutely-positioned **「×」** close in its top-right corner (that button keeps the id
`update-later-btn`) and a small underlined **「今後表示しない」** text link.

The action row is `flex-wrap: wrap; row-gap: 6px` because the four controls only just fit
the fixed `min(320px, …)` card; `#update-optout-btn`'s `margin-left: auto` keeps the
opt-out at the right edge whether or not it wraps, which is why a new button belongs
*before* it. Its `z-index` (9600) sits *below* `#toast` (10000) and the modals (10001) so
a notification arriving while the help modal is open never lands on top of it, and
`body.marp.deck-mode` nudges it above `#slide-counter`. Appearance is a `@keyframes`
animation rather than a transition, because the `.visible` class is added in the same
frame as `display: none` → `flex`. 「今後表示しない」 persists
`localStorage['autoUpdate:optout']='true'` so a user can permanently suppress it on their
machine even under a managed build; the banner JS gates on that flag. `body.capturing`
hides the banner so `--export-png` shots are unaffected.

**Notes come from the network now.** `showBanner` puts them through `escapeHtml`, which
is what makes a remote release body safe to display; `summarize_notes` in Rust first
squashes the Markdown `HISTORY.md` section to one line — strips list/heading markers and
`**`/`` ` `` — and truncates at `NOTES_MAX_CHARS` **by char, not byte** (the notes are
Japanese; a byte slice would panic mid-codepoint).

`window.__updateInstallPending` / `__updateInstallFailed` re-resolve the button with
`getElementById` on every call instead of closing over it, so a host message arriving
before `DOMContentLoaded` is a no-op rather than a throw.

### The notification must survive arriving mid-page-load

This used to be the common case (the check thread was spawned before the webview
existed). Now that the check is released by `renderdone:`, `__updateAvailable` is
normally long since defined — but the **watchdog path can still fire while a slow
document is parsing**, so the stash is still load-bearing and must not be removed. Both
halves stash instead of dropping, mirroring `loadFileFromRust`'s `DOMContentLoaded`+retry
and the `__pendingWorkspace` stash:

1. **Rust** emits `if (typeof window.__updateAvailable === 'function') { … } else {
   window.__pendingUpdate = … }` — the previous bare `window.__updateAvailable && …`
   short-circuited to nothing when the function wasn't reached yet.
2. **JS** — `__updateAvailable` defers into an IIFE-scoped `pending` when
   `document.readyState === 'loading'` or `#update-banner` (~6000 lines *after* the
   function) isn't parsed yet, and the existing `DOMContentLoaded` handler drains both
   `pending` and `window.__pendingUpdate`.

Without both, the banner was silently lost until the next launch — the actual cause of
the 「自動更新が働かない」 report, confirmed by CDP-inspecting a live 0.17.0 install.

## Install paths

- **「今すぐ更新」** — posts `update:install`; the IPC handler (next to `openinstalldir:`)
  runs the three-way match above. The launching branch calls
  `updater::launch_installer_and_relaunch(setup_temp, exe_path, current_file)` on a
  worker thread, which spawns a detached `cmd /S /C "…"` (CREATE_NO_WINDOW) that: waits
  ~1 s (`ping -n 2 127.0.0.1 >nul` — console-independent, unlike `timeout`) so this app
  fully exits and releases its exe lock, runs the Inno installer
  `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART` (per-user, no UAC; stable AppId ⇒ in-place
  upgrade), then `start`s the (new) exe — reopening the current file if one was open. It
  then posts `CustomEvent::QuitForUpdate` ⇒ `ControlFlow::Exit`. (`skipifsilent` in the
  installer's `[Run]` means the installer won't relaunch the app itself, so the wrapper's
  `start` does it.) The command string is built by the pure, unit-tested
  **`installer_cmd_line(setup, relaunch)`**; `launch_installer_and_relaunch` is a thin
  wrapper over **`launch_installer(setup, relaunch)`**, which every path shares.
  ⚠ The IPC handler is constructed **before** the webview exists, so it has no handle:
  everything it needs to say to the page goes through the event proxy, which is why
  `UpdateInstallPending` / `UpdateInstallFailed` are `CustomEvent`s and not
  `evaluate_script` calls.
- **「終了後に更新」** — posts `update:onexit`, whose IPC arm does nothing but set the
  shared `install_on_exit: Arc<Mutex<bool>>` and log — no thread, no `update_ready` read.
  The banner closes and a toast confirms the reservation, so the reader keeps working.
  The install happens in `run_deferred_update()`, called from the
  **`WindowEvent::CloseRequested` else-branch** — the app's only user-initiated quit —
  just before `ControlFlow::Exit`; it passes `relaunch: None`, so the chain stops after
  the installer and the new version simply appears at the next launch. **The call is
  synchronous, not on a worker thread**: the process is exiting, and a detached thread
  can be killed before its `spawn()` completes (`Command::spawn` returns immediately, so
  the quit isn't held up). The reservation is in-memory and per-session. With GitHub it
  can find `update_ready` still `None` if the download had not landed by the time the
  user quit; it logs that and does nothing, and the banner returns next launch.

## Failure = silent no-op

Unreachable source, timeout, missing/invalid manifest, rate limit, no installer asset,
draft/prerelease — all log to `md-previewer.log` (`updater: …`) and return `None`. The UI
is never disturbed.

## Tests

`src/updater.rs` `#[cfg(test)]` — provider resolution (all six cases, including the
back-compat inference), per-provider timeout defaults, `load_config`'s gate, the shipped
`assets/update.json`, `github_api_url` normalisation, `parse_github_release` against a
payload shaped like the live one, same/older ⇒ `None`, draft/prerelease ⇒ `None`, no
installer asset ⇒ `None`, garbage JSON ⇒ `None`, `pick_setup_asset`, `summarize_notes`
(incl. the CJK truncation), `should_check` boundaries, the stamp round trip,
`github_found_is_not_ready_before_download`, `installer_cmd_line` (both command strings),
`installer_temp_path_for_name` (incl. that a remote `../../evil.exe` cannot steer the
write out of the temp directory), and the unchanged share-provider phase 1 / phase 2 /
soft-failure tests. `src/http_win.rs` — five `crack_url` cases.

Two `#[ignore]`d live tests need the network:
`cargo test -- --ignored` runs `http_win::tests::live_get` and
`updater::tests::github_live_check`.

## Distributor setup

Preparing a share, publishing a new version to it, and writing `latest.json` is
documented by the distributor's own package. The GitHub side needs nothing: it is the
existing `release-on-main.ps1 -Publish` output.
