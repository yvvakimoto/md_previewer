import { startCompletion } from '@codemirror/autocomplete';

// Local-path completion for markdown link / image targets:
//   [label](|)   →  sibling files & folders
//   ![alt](sub/| →  contents of sub/
//
// Relies on a Rust-side IPC channel:
//   JS → Rust: window.ipc.postMessage('editor:listdir:' + JSON.stringify({id, base, sub}))
//   Rust → JS: window.__listDirResult(id, entries)
// where entries is [{name, isDir}], directories first, alphabetical.

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;
const MD_EXT = /\.(md|markdown)$/i;

let nextId = 1;
const pending = new Map(); // id -> { resolve, timeout }
const cache = new Map();   // `${base}\0${sub}` -> { ts, entries }
const CACHE_TTL_MS = 2000;

// Rust calls this directly via evaluate_script.
function onListDirResult(id, entries) {
  const slot = pending.get(id);
  if (!slot) return;
  clearTimeout(slot.timeout);
  pending.delete(id);
  slot.resolve(Array.isArray(entries) ? entries : []);
}

if (typeof window !== 'undefined') {
  window.__listDirResult = onListDirResult;
}

function requestListing(base, sub) {
  const key = `${base}\0${sub}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.ts < CACHE_TTL_MS) return Promise.resolve(hit.entries);

  return new Promise((resolve) => {
    const id = nextId++;
    const timeout = setTimeout(() => {
      pending.delete(id);
      resolve([]);
    }, 1500);
    pending.set(id, {
      resolve: (entries) => {
        cache.set(key, { ts: Date.now(), entries });
        resolve(entries);
      },
      timeout,
    });
    try {
      window.ipc.postMessage('editor:listdir:' + JSON.stringify({ id, base, sub }));
    } catch (_) {
      clearTimeout(timeout);
      pending.delete(id);
      resolve([]);
    }
  });
}

// Split user-typed partial into (subDir, prefix).
//   ""           -> { sub: "", prefix: "" }
//   "fo"         -> { sub: "", prefix: "fo" }
//   "images/"    -> { sub: "images", prefix: "" }
//   "images/fo"  -> { sub: "images", prefix: "fo" }
function splitPartial(p) {
  const i = p.lastIndexOf('/');
  if (i < 0) return { sub: '', prefix: p };
  return { sub: p.slice(0, i), prefix: p.slice(i + 1) };
}

// Native path-dirname for a Windows-or-POSIX absolute path. We only need the
// parent dir of the currently open markdown file — both separators are handled.
function parentDir(absPath) {
  if (!absPath) return '';
  const norm = absPath.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  return i < 0 ? '' : absPath.slice(0, i);
}

function shouldKeep(entry, isImage) {
  if (entry.isDir) return true;
  if (isImage) return IMAGE_EXT.test(entry.name);
  return MD_EXT.test(entry.name) || IMAGE_EXT.test(entry.name);
}

// Build the completion source bound to a live `getFile()` accessor so the
// editor's currentPath reference stays fresh across file switches.
export function pathCompletionSource(getFile) {
  return async function pathSource(context) {
    const line = context.state.doc.lineAt(context.pos);
    const before = context.state.doc.sliceString(line.from, context.pos);
    // Match the URL portion of a markdown link/image: `[label](partial`
    const m = /(!?)\[[^\]\n]*\]\(([^)\s]*)$/.exec(before);
    if (!m) return null;

    const isImage = m[1] === '!';
    const partial = m[2];
    // Don't try to complete absolute URLs or anchors.
    if (/^[a-zA-Z]+:/.test(partial) || partial.startsWith('#') || partial.startsWith('/')) {
      return null;
    }

    const filePath = (typeof getFile === 'function') ? getFile() : '';
    const base = parentDir(filePath);
    if (!base) return null;

    const { sub, prefix } = splitPartial(partial);

    if (!context.explicit && prefix === '' && sub === '' && !before.endsWith('(')) {
      // Avoid firing on totally unrelated text.
    }

    const entries = await requestListing(base, sub);
    if (!entries || !entries.length) return null;

    const filtered = entries.filter((e) => shouldKeep(e, isImage));
    if (!filtered.length) return null;

    const options = filtered.map((e) => {
      const insertion = e.isDir ? e.name + '/' : e.name;
      const base = {
        label: insertion,
        displayLabel: e.name,
        type: e.isDir ? 'folder' : 'file',
        detail: e.isDir ? 'dir' : (e.name.match(/\.([^.]+)$/) || [, ''])[1],
        boost: e.isDir ? 1 : 0,
      };
      if (e.isDir) {
        // Apply the directory name + `/`, then immediately reopen the popup so
        // the user can keep drilling down without retyping a trigger character.
        base.apply = (view, _completion, from, to) => {
          view.dispatch({
            changes: { from, to, insert: insertion },
            selection: { anchor: from + insertion.length },
          });
          setTimeout(() => startCompletion(view), 0);
        };
      }
      return base;
    });

    // The completion range covers just the prefix portion after the last `/`.
    const from = context.pos - prefix.length;
    return {
      from,
      to: context.pos,
      options,
      // Re-query whenever the user types a `/` (drilled into a subdir) or a
      // non-name character. Plain word chars keep the popup live-filtering.
      validFor: /^[^\/\s)]*$/,
    };
  };
}
