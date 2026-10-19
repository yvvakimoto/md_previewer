import { startCompletion } from '@codemirror/autocomplete';
import { t } from './i18n.js';
import { fenceInfoAt } from './fenceTemplateComplete.js';

// Local-path completion for markdown link / image targets:
//   [label](|)   →  sibling files & folders
//   ![alt](sub/| →  contents of sub/
// and for the path-valued keys of figure fences (see FENCE_PATH_KEYS):
//   ```plotly  file: |      ```model3d  file: | / mtl: |
//
// Relies on a Rust-side IPC channel:
//   JS → Rust: window.ipc.postMessage('editor:listdir:' + JSON.stringify({id, base, sub}))
//   Rust → JS: window.__listDirResult(id, entries)
// where entries is [{name, isDir}], directories first, alphabetical.

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;
const VIDEO_EXT = /\.(mov|mp4|m4v|webm|ogv|ogg)$/i;
const MD_EXT = /\.(md|markdown)$/i;
// Fence bodies: plotly `file:` reads CSV/TSV; model3d `file:` the mesh formats
// three.js loads (tools/build-three/entry.js), `mtl:` an OBJ's material file.
const DATA_EXT = /\.(csv|tsv)$/i;
const MESH_EXT = /\.(stl|obj|ply|gltf|glb|3mf)$/i;
const MTL_EXT = /\.mtl$/i;

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

// `![](…)` targets media (images + video); `[](…)` also allows .md links.
function linkKeep(isImage) {
  return (name) => (isImage
    ? IMAGE_EXT.test(name) || VIDEO_EXT.test(name)
    : MD_EXT.test(name) || IMAGE_EXT.test(name) || VIDEO_EXT.test(name));
}

// Path-valued keys inside figure fences, keyed by fence language. `bare` is the
// model3d shorthand where the whole body is just the path.
const FENCE_PATH_KEYS = {
  plotly:  { file: DATA_EXT },
  model3d: { file: MESH_EXT, mtl: MTL_EXT, bare: MESH_EXT },
};

// Where (if anywhere) the cursor sits in a completable path, as
// { partial, keep(name) }. Pure — exported for templates.test.mjs.
//   [label](partial      ![alt](partial
//   ```plotly  file: partial
//   ```model3d file: partial / mtl: partial / partial (first body line)
export function pathContextAt(state, pos) {
  const line = state.doc.lineAt(pos);
  const before = state.doc.sliceString(line.from, pos);

  const m = /(!?)\[[^\]\n]*\]\(([^)\s]*)$/.exec(before);
  if (m) return { partial: m[2], keep: linkKeep(m[1] === '!') };

  const fence = fenceInfoAt(state, pos);
  const keys = fence && FENCE_PATH_KEYS[fence.lang];
  if (!keys) return null;
  const kv = /^\s*([A-Za-z]+)\s*:\s*["']?([^\s"']*)$/.exec(before);
  if (kv) {
    const re = keys[kv[1].toLowerCase()];
    return re ? { partial: kv[2], keep: (n) => re.test(n) } : null;
  }
  if (keys.bare && line.number === fence.openLine + 1) {
    const bare = /^\s*["']?([^\s:"']*)$/.exec(before);
    if (bare) return { partial: bare[1], keep: (n) => keys.bare.test(n) };
  }
  return null;
}

// Build the completion source bound to a live `getFile()` accessor so the
// editor's currentPath reference stays fresh across file switches.
export function pathCompletionSource(getFile) {
  return async function pathSource(context) {
    const ctx = pathContextAt(context.state, context.pos);
    if (!ctx) return null;
    const { partial } = ctx;
    // Don't try to complete absolute URLs or anchors.
    if (/^[a-zA-Z]+:/.test(partial) || partial.startsWith('#') || partial.startsWith('/')) {
      return null;
    }

    const filePath = (typeof getFile === 'function') ? getFile() : '';
    const base = parentDir(filePath);
    if (!base) return null;

    const { sub, prefix } = splitPartial(partial);

    const entries = await requestListing(base, sub);

    const filtered = (entries || []).filter((e) => e.isDir || ctx.keep(e.name));

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

    // Synthetic "go up a level" entry: insert `../` and reopen the popup so the
    // user can drill UP into parent directories without typing it by hand.
    // Matches the preview's support for `../` file references (Rust now lists
    // `..`-containing sub-paths). Only shown when the typed prefix is empty
    // (right after `(` or a `/`) so it doesn't clutter a filename being typed.
    if (prefix === '') {
      options.unshift({
        label: '../',
        displayLabel: '../',
        type: 'folder',
        detail: t('ed.complete.parentDir'),
        boost: 2,
        apply: (view, _completion, from, to) => {
          view.dispatch({
            changes: { from, to, insert: '../' },
            selection: { anchor: from + 3 },
          });
          setTimeout(() => startCompletion(view), 0);
        },
      });
    }

    if (!options.length) return null;

    // The completion range covers just the prefix portion after the last `/`.
    const from = context.pos - prefix.length;
    return {
      from,
      to: context.pos,
      options,
      // Re-query whenever the user types a `/` (drilled into a subdir) or a
      // non-name character. Plain word chars keep the popup live-filtering.
      validFor: /^[^\/\s)"']*$/,
    };
  };
}
