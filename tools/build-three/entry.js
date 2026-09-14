// ---------------------------------------------------------------------------
// window.Model3D — the ```model3d fenced-block engine's whole implementation.
//
// ⚠ DO NOT turn this into `export * from 'three'`, however much the sibling
// tools/build-markwhen/entry.js looks like the pattern to copy. With
// format:'iife' the entry's exports ARE the public surface, so a star
// re-export is unreachable-by-nothing and esbuild cannot shake anything:
// measured, that is ~890KB instead of ~695KB. Exporting only the facade below
// is what lets esbuild drop the ~380 core symbols this engine never touches.
// (three declares `sideEffects` outside src/nodes/**, and esbuild honours it.)
//
// ⚠ Never import `three/webgpu`, `three/tsl`, `renderers/webgpu/*` or
// `examples/jsm/tsl/*`. Those carry top-level await, which cannot be expressed
// in an IIFE — it is the one way to break this build.
//
// WHY ALL STATE LIVES HERE, OUTSIDE #preview
// ------------------------------------------
// `#preview` is rebuilt wholesale by innerHTML on every render, including every
// ~150ms live-edit keystroke. A per-block WebGLRenderer would therefore leak a
// WebGL context per keystroke and silently blow past Chromium's ~16-context
// page cap (release builds have no devtools, so the symptom is older figures
// going blank with no message). So: ONE renderer on a detached canvas, plus a
// model LRU, a rendered-bitmap LRU and a camera-state map — all module-level,
// exactly the layering kataskeve3d uses for its offscreen bitmap LRU.
//
// WHY THE VISIBLE CANVAS IS 2D, NOT WEBGL
// ---------------------------------------
// Each block owns a plain 2D <canvas>; we render into the shared WebGL canvas
// and blit with drawImage in the SAME task. That makes the captured surface a
// 2D canvas whose bitmap toDataURL() reads back trivially — the exact path
// kataskeve3d already proved through HTML export, PDF and --export-png.
// Measured in the hidden --export-png window: webgl2 OK on a real GPU
// (ANGLE/D3D11), blit pixels correct, toDataURL fine.
// ---------------------------------------------------------------------------

import {
  WebGLRenderer, Scene, PerspectiveCamera, Group, Color, Box3, Vector3,
  Mesh, MeshStandardMaterial, AmbientLight, DirectionalLight, HemisphereLight,
  EdgesGeometry, LineSegments, LineBasicMaterial, GridHelper, AxesHelper,
  LoadingManager, DoubleSide,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
// The file is 3MFLoader.js but the class is ThreeMFLoader — an identifier
// cannot start with a digit.
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import WebGL from 'three/addons/capabilities/WebGL.js';

// ---------------------------------------------------------------------------
// Tuned constants. Mirrored in CLAUDE.md's "Tuned constants" table.
// ---------------------------------------------------------------------------

// Backing-store multiplier. FIXED AT 2 — deliberately NOT devicePixelRatio.
// src/png_win.rs passes clip.scale = --png-scale (default 2) to
// Page.captureScreenshot, so a bitmap at CSS size gets resampled 2x by the
// compositor (which is why kataskeve3d's --export-png output is soft today); a
// 2x backing store rasterizes 1:1. Reading real DPR instead would make the
// exported PNG bytes machine-dependent and break domdump.py / shoot.py /
// exportcheck.py on any display not at 100%.
const SS = 2;

const DEFAULT_W = 680;
const DEFAULT_H = 460;
// Keeps the shared GL canvas within 2048 per axis at SS = 2.
const MAX_LOGICAL_W = 1024;
const MAX_LOGICAL_H = 1024;

const MODEL_CACHE_MAX = 8;    // parsed meshes; entries are large
const BITMAP_CACHE_MAX = 12;  // ~5MB each at 680x460 SS=2 (kataskeve3d's 64 would be ~320MB)
const MATERIAL_CACHE_MAX = 32;
const CAMERA_STATE_MAX = 200; // mirrors __DIAGRAM_CACHE_MAX

const FETCH_TIMEOUT_MS = 15000;
const MAX_BYTES = 64 * 1024 * 1024;

const SUPPORTED = ['stl', 'obj', 'ply', 'gltf', 'glb', '3mf'];

// ---------------------------------------------------------------------------
// Module state — survives the #preview innerHTML rebuild by construction.
// ---------------------------------------------------------------------------

let renderer = null;
let glCanvas = null;
let rendererW = 0;
let rendererH = 0;
let rendererBroken = false;

const modelCache = new Map();     // 'url|lastModified' -> { root, isTemplateGeometry }
const bitmapCache = new Map();    // render key -> detached canvas holding the pixels
const materialCache = new Map();  // signature -> MeshStandardMaterial
const cameraStates = new Map();   // 'srcHash|ordinal' -> { position, target }

// Mounted blocks. Rebuilt from scratch every render; unmountAll() empties it.
let blocks = [];

let rafHandle = 0;
let timeoutHandle = 0;
let webglOk = null;               // memoized capability probe

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function hashString(s) {
  // FNV-1a. Only needs to be stable and cheap — it keys caches, not security.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function lruSet(map, key, value, cap, onEvict) {
  if (map.size >= cap) {
    const oldest = map.keys().next().value;
    const victim = map.get(oldest);
    map.delete(oldest);
    if (onEvict) { try { onEvict(victim); } catch (e) { /* disposal is best-effort */ } }
  }
  map.set(key, value);
}

function disposeMaterial(mat) {
  if (!mat) return;
  const list = Array.isArray(mat) ? mat : [mat];
  for (const m of list) {
    if (!m) continue;
    // Walk every slot rather than naming map/normalMap/... — a loaded glTF
    // material can carry maps this engine never sets.
    for (const v of Object.values(m)) {
      if (v && v.isTexture) { try { v.dispose(); } catch (e) {} }
    }
    try { m.dispose(); } catch (e) {}
  }
}

function disposeObject(root) {
  if (!root) return;
  root.traverse((o) => {
    if (o.geometry) { try { o.geometry.dispose(); } catch (e) {} }
    if (o.material) disposeMaterial(o.material);
  });
}

function clampSize(spec) {
  const w = Math.max(80, Math.min(MAX_LOGICAL_W, Math.round(Number(spec.width) || DEFAULT_W)));
  const h = Math.max(80, Math.min(MAX_LOGICAL_H, Math.round(Number(spec.height) || DEFAULT_H)));
  return { w, h };
}

function extOf(path) {
  const m = /\.([A-Za-z0-9]+)(?:[?#]|$)/.exec(String(path || ''));
  return m ? m[1].toLowerCase() : '';
}

// ---------------------------------------------------------------------------
// Capability probe
// ---------------------------------------------------------------------------

function available() {
  if (webglOk === null) {
    // isWebGL2Available() creates a throwaway canvas + context on every call
    // and never throws (it try/catches internally), so memoize it.
    // NB. isWebGLAvailable() was removed in r163 — three is WebGL2-only now.
    try { webglOk = !!WebGL.isWebGL2Available(); } catch (e) { webglOk = false; }
  }
  return webglOk;
}

// ---------------------------------------------------------------------------
// The one renderer
// ---------------------------------------------------------------------------

function ensureRenderer() {
  if (renderer && !rendererBroken) return renderer;
  if (rendererBroken) destroyRenderer();

  glCanvas = document.createElement('canvas');
  glCanvas.width = 1;
  glCanvas.height = 1;

  // A GPU-process crash, driver reset or RDP session change kills the context.
  // Without preventDefault() it is never restored.
  glCanvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    rendererBroken = true;
  });
  glCanvas.addEventListener('webglcontextrestored', () => {
    // Every GPU-resident buffer is gone with the context, so the parsed-model
    // cache is worthless; drop it and rebuild from source on the next render.
    rendererBroken = true;
    clearModelCache();
    bitmapCache.clear();
    scheduleRender();
  });

  renderer = new WebGLRenderer({
    canvas: glCanvas,
    antialias: true,
    alpha: true,
    // Belt-and-braces. render() -> drawImage() in the same task is already
    // safe (the implicit clear happens at a composite checkpoint, and this
    // canvas is never in the DOM so it is never composited), but the day
    // somebody "optimizes" the scheduler into rendering and blitting in
    // different tasks, the failure is a black figure with no error at all.
    preserveDrawingBuffer: true,
  });
  // NEVER setPixelRatio() — it multiplies setSize and would silently double
  // the allocation on a HiDPI machine, reintroducing exactly the DPR
  // nondeterminism the fixed SS above exists to eliminate.
  renderer.setClearColor(0x000000, 0);
  rendererW = 0;
  rendererH = 0;
  rendererBroken = false;
  return renderer;
}

function destroyRenderer() {
  if (renderer) { try { renderer.dispose(); } catch (e) {} }
  renderer = null;
  glCanvas = null;
  rendererW = 0;
  rendererH = 0;
  rendererBroken = false;
}

// Grow-only. setSize() reallocates the drawing buffer and, with antialias,
// the multisample renderbuffers — calling it per block per frame during an
// orbit drag is an allocation storm at 60Hz.
function ensureRendererSize(w, h) {
  if (w <= rendererW && h <= rendererH) return;
  rendererW = Math.max(rendererW, w);
  rendererH = Math.max(rendererH, h);
  // updateStyle:false — this canvas has no business carrying CSS dimensions.
  renderer.setSize(rendererW, rendererH, false);
}

function materialFor(colorHex, wireframe) {
  const sig = colorHex + '|' + (wireframe ? 'w' : 's');
  const hit = materialCache.get(sig);
  if (hit) return hit;
  // A material per render would leak WebGLPrograms cache entries (a program is
  // only released when its material is disposed) AND pay a 10-50ms shader
  // compile each time. Colour is a uniform, so distinct colours share one
  // compiled program — this cache is bounded and cheap.
  const mat = new MeshStandardMaterial({
    color: new Color(colorHex),
    roughness: 0.55,
    metalness: 0.05,
    wireframe: !!wireframe,
    side: DoubleSide,   // CAD exports are frequently not watertight
    flatShading: false,
  });
  lruSet(materialCache, sig, mat, MATERIAL_CACHE_MAX, disposeMaterial);
  return mat;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function makeManager(urlModifier) {
  const mgr = new LoadingManager();
  if (typeof urlModifier === 'function') {
    // Sub-resources (a .gltf's .bin, an .mtl's textures) are resolved INSIDE
    // three, bypassing index.html's toUserfileUrl(). Without routing them
    // through encodePathForUserfile() any Japanese folder or texture name
    // 404s — and the recorded failure mode is %E6 -> %25E6, which Rust's
    // single urlencoding::decode() cannot recover.
    mgr.setURLModifier(urlModifier);
  }
  return mgr;
}

async function fetchBounded(url, signal) {
  const resp = await fetch(url, { signal });
  if (!resp.ok) {
    const err = new Error('HTTP ' + resp.status);
    err.status = resp.status;
    throw err;
  }
  const declared = Number(resp.headers.get('Content-Length') || 0);
  if (declared > MAX_BYTES) {
    const err = new Error('too large');
    err.tooLarge = { bytes: declared, max: MAX_BYTES };
    throw err;
  }
  const buf = await resp.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) {
    const err = new Error('too large');
    err.tooLarge = { bytes: buf.byteLength, max: MAX_BYTES };
    throw err;
  }
  return { buf, lastModified: resp.headers.get('Last-Modified') || '' };
}

function loadViaLoader(loader, url) {
  return new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, (err) => {
      // three's FileLoader throws an HttpError carrying .response.status and a
      // message naming the exact URL — a better string than loadLib's.
      reject(err instanceof Error ? err : new Error(String((err && err.message) || err)));
    });
  });
}

// Resolves to { root, fromGeometry }. `root` is a TEMPLATE: callers clone it,
// which shares geometry and materials by reference (what we want).
async function loadModel(spec, signal) {
  const fmt = spec.format || extOf(spec.url);
  if (SUPPORTED.indexOf(fmt) < 0) {
    const err = new Error('unsupported format');
    err.badFormat = fmt || '?';
    throw err;
  }

  const mgr = makeManager(spec.urlModifier);

  // Two families, and the split is deliberate:
  //  - self-contained formats are fetched HERE so the size cap and the abort
  //    timeout actually apply, then handed to the synchronous .parse();
  //  - formats that resolve sibling files (.gltf's .bin/textures, .obj's .mtl)
  //    must go through loader.load() so three does that resolution itself.
  const selfContained = (fmt === 'stl' || fmt === 'ply' || fmt === '3mf' || fmt === 'glb');

  let cacheKey = spec.url + '|';
  let payload = null;
  if (selfContained) {
    payload = await fetchBounded(spec.url, signal);
    // Last-Modified is what makes a re-export from a CAD tool actually show
    // up; without it the LRU would serve a stale mesh forever.
    cacheKey += payload.lastModified;
  } else {
    cacheKey += 'byloader';
  }

  const cached = modelCache.get(cacheKey);
  if (cached) return cached;

  let root = null;
  let fromGeometry = false;
  // Distinguishes materials AUTHORED IN THE FILE from three's placeholder
  // default. `color:` overrides the placeholder (an .obj with no .mtl would
  // otherwise render grey and silently ignore the user's colour) but never
  // overrides authored materials, which would wreck a textured glTF.
  let hasFileMaterials = false;

  if (fmt === 'stl') {
    const geo = new STLLoader(mgr).parse(payload.buf);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    root = geo;
    fromGeometry = true;
  } else if (fmt === 'ply') {
    const geo = new PLYLoader(mgr).parse(payload.buf);
    // r185: PLYLoader now honours the file's declared types, so a
    // `property int x` yields an Int32BufferAttribute. computeVertexNormals()
    // copes, but do not assume Float32 downstream.
    if (!geo.attributes.normal) geo.computeVertexNormals();
    root = geo;
    fromGeometry = true;
  } else if (fmt === '3mf') {
    root = new ThreeMFLoader(mgr).parse(payload.buf);
    hasFileMaterials = true;
  } else if (fmt === 'glb') {
    const gltf = await new GLTFLoader(mgr).parseAsync(payload.buf, spec.resourcePath || '');
    root = gltf.scene || gltf.scenes[0];
    hasFileMaterials = true;
  } else if (fmt === 'gltf') {
    const loader = new GLTFLoader(mgr);
    if (spec.resourcePath) loader.setResourcePath(spec.resourcePath);
    const gltf = await loadViaLoader(loader, spec.url);
    root = gltf.scene || gltf.scenes[0];
    hasFileMaterials = true;
  } else if (fmt === 'obj') {
    const loader = new OBJLoader(mgr);
    if (spec.mtlUrl) {
      try {
        const mtlLoader = new MTLLoader(mgr);
        if (spec.resourcePath) mtlLoader.setResourcePath(spec.resourcePath);
        const materials = await loadViaLoader(mtlLoader, spec.mtlUrl);
        materials.preload();
        loader.setMaterials(materials);
        hasFileMaterials = true;
      } catch (e) {
        // A missing .mtl costs colour, not the model.
      }
    }
    root = await loadViaLoader(loader, spec.url);
  }

  const entry = { root, fromGeometry, hasFileMaterials };
  lruSet(modelCache, cacheKey, entry, MODEL_CACHE_MAX, (victim) => {
    if (!victim) return;
    if (victim.fromGeometry) { try { victim.root.dispose(); } catch (e) {} }
    else disposeObject(victim.root);
  });
  return entry;
}

function clearModelCache() {
  for (const entry of modelCache.values()) {
    if (!entry) continue;
    if (entry.fromGeometry) { try { entry.root.dispose(); } catch (e) {} }
    else disposeObject(entry.root);
  }
  modelCache.clear();
}

// ---------------------------------------------------------------------------
// Scene construction
// ---------------------------------------------------------------------------

function buildScene(entry, spec, logical) {
  const scene = new Scene();
  const content = new Group();

  if (entry.fromGeometry) {
    content.add(new Mesh(entry.root, materialFor(spec.color, spec.wireframe)));
  } else {
    const clone = entry.root.clone(true);
    if (!entry.hasFileMaterials) {
      const mat = materialFor(spec.color, spec.wireframe);
      clone.traverse((o) => { if (o.isMesh) o.material = mat; });
    } else if (spec.wireframe) {
      clone.traverse((o) => {
        if (!o.material) return;
        for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
          if (m) m.wireframe = true;
        }
      });
    }
    content.add(clone);
  }

  // Centre on the origin so orbiting feels right regardless of the file's
  // own coordinate system (CAD exports are often far from the origin).
  const box = new Box3().setFromObject(content);
  const size = box.getSize(new Vector3());
  const centre = box.getCenter(new Vector3());
  const radius = Math.max(size.length() / 2, 1e-4);
  content.position.sub(centre);
  scene.add(content);

  if (spec.edges) {
    const edgeMat = new LineBasicMaterial({ color: new Color(spec.edgeColor) });
    const targets = [];
    content.traverse((o) => { if (o.isMesh && o.geometry) targets.push(o); });
    for (const mesh of targets) {
      const seg = new LineSegments(new EdgesGeometry(mesh.geometry, 20), edgeMat);
      seg.applyMatrix4(mesh.matrixWorld);
      content.add(seg);
    }
  }

  if (spec.grid) {
    const grid = new GridHelper(radius * 4, 20, spec.gridColor, spec.gridColor);
    grid.position.y = -size.y / 2;
    scene.add(grid);
  }
  if (spec.axes) scene.add(new AxesHelper(radius * 1.4));

  scene.add(new AmbientLight(0xffffff, 0.55));
  scene.add(new HemisphereLight(0xffffff, 0x404050, 0.5));
  const key = new DirectionalLight(0xffffff, 1.5);
  key.position.set(1, 1.4, 1.2);
  scene.add(key);
  const fill = new DirectionalLight(0xffffff, 0.45);
  fill.position.set(-1, -0.4, -0.8);
  scene.add(fill);

  const FOV = 45;
  const camera = new PerspectiveCamera(FOV, logical.w / logical.h, radius / 100, radius * 100);
  const az = (spec.azimuth === undefined || spec.azimuth === null ? 35 : Number(spec.azimuth)) * Math.PI / 180;
  const el = (spec.elevation === undefined || spec.elevation === null ? 22 : Number(spec.elevation)) * Math.PI / 180;

  // Unit vector from the (origin-centred) content towards the camera.
  const dir = new Vector3(
    Math.cos(el) * Math.sin(az),
    Math.sin(el),
    Math.cos(el) * Math.cos(az),
  ).normalize();

  // Fit the bounding BOX to the frustum, not the bounding sphere. A sphere fit
  // is one line and viewing-angle independent, but for the flat or elongated
  // parts most CAD exports contain it leaves roughly half the box empty. Build
  // the same basis three's lookAt() will (z = dir, x = up x z, y = z x x),
  // project the 8 corners onto it, and take the distance the worst one needs.
  const worldUp = new Vector3(0, 1, 0);
  const right = new Vector3().crossVectors(worldUp, dir);
  // Degenerate when looking straight down or up, where cross() is ~zero.
  if (right.lengthSq() < 1e-8) right.set(1, 0, 0); else right.normalize();
  const up = new Vector3().crossVectors(dir, right).normalize();
  const tanV = Math.tan((FOV / 2) * Math.PI / 180);
  const tanH = tanV * camera.aspect;
  const half = size.clone().multiplyScalar(0.5);
  let need = 0;
  for (let sx = -1; sx <= 1; sx += 2) {
    for (let sy = -1; sy <= 1; sy += 2) {
      for (let sz = -1; sz <= 1; sz += 2) {
        const corner = new Vector3(half.x * sx, half.y * sy, half.z * sz);
        // A corner at camera-space depth z fits when |x| <= z*tanH and
        // |y| <= z*tanV; depth is D - corner.dot(dir), hence the + here.
        need = Math.max(need, Math.max(
          Math.abs(corner.dot(right)) / tanH,
          Math.abs(corner.dot(up)) / tanV,
        ) + corner.dot(dir));
      }
    }
  }
  const dist = (Number(spec.cameraDistance) > 0)
    ? Number(spec.cameraDistance) * radius
    : Math.max(need * 1.06, radius * 1e-3);
  camera.position.copy(dir).multiplyScalar(dist);
  camera.lookAt(0, 0, 0);
  // Generous far plane so wheel-zooming out does not clip the model.
  camera.near = Math.max(radius / 1000, 1e-5);
  camera.far = dist + radius * 40;
  camera.updateProjectionMatrix();

  return { scene, camera, radius };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function cameraKeyOf(rec) { return rec.srcKey; }

function renderKeyOf(rec) {
  const c = rec.camera.position;
  const cam = [c.x, c.y, c.z].map((n) => n.toFixed(3)).join(',');
  return rec.srcKey + '|' + rec.themeSalt + '|' + cam;
}

function renderBlock(rec) {
  if (!rec.ctx || !rec.canvas) return;
  const w = rec.logical.w * SS;
  const h = rec.logical.h * SS;

  const key = renderKeyOf(rec);
  const cachedBitmap = bitmapCache.get(key);
  if (cachedBitmap && cachedBitmap.width === w && cachedBitmap.height === h) {
    rec.ctx.clearRect(0, 0, w, h);
    rec.ctx.drawImage(cachedBitmap, 0, 0);
    rec.dirty = false;
    return;
  }

  if (!rec.scene || rendererBroken) return;
  const r = ensureRenderer();
  ensureRendererSize(w, h);

  // GL's viewport/scissor origin is BOTTOM-left; drawImage's source rect
  // origin is TOP-left. Rendering into (0, rendererH - h) puts the region at
  // (0, 0, w, h) in canvas space, so the blit source rect is trivial.
  // Verified empirically in the Step-0 probe. Pick one convention; never mix.
  const y = rendererH - h;
  r.setViewport(0, y, w, h);
  r.setScissor(0, y, w, h);
  // Without the scissor, autoClear clears the WHOLE framebuffer at the start
  // of render(), so a block would wipe its predecessor's pixels. Harmless
  // while we blit each block before rendering the next, but free insurance.
  r.setScissorTest(true);
  r.setClearColor(new Color(rec.bgColor), rec.bgAlpha);
  r.render(rec.scene, rec.camera);
  r.setScissorTest(false);

  rec.ctx.clearRect(0, 0, w, h);
  rec.ctx.drawImage(glCanvas, 0, 0, w, h, 0, 0, w, h);
  rec.dirty = false;

  const snap = document.createElement('canvas');
  snap.width = w;
  snap.height = h;
  snap.getContext('2d').drawImage(rec.canvas, 0, 0);
  lruSet(bitmapCache, key, snap, BITMAP_CACHE_MAX, (victim) => {
    // Free the backing store rather than waiting for GC — at ~5MB an entry
    // that wait is what a user feels as a stutter.
    if (victim) { victim.width = 0; victim.height = 0; }
  });
}

function flushNow() {
  if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = 0; }
  if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = 0; }
  for (const rec of blocks) {
    try { renderBlock(rec); } catch (e) { /* one bad block must not stop the rest */ }
  }
}

function scheduleRender() {
  if (rafHandle || timeoutHandle) return;
  const fire = () => {
    if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = 0; }
    if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = 0; }
    for (const rec of blocks) {
      if (!rec.dirty) continue;
      try { renderBlock(rec); } catch (e) {}
    }
  };
  // rAF alone is not enough: it never fires in the hidden window --export-png
  // renders into, nor in a backgrounded tab. The timeout is the same race
  // __nextPaint() runs in assets/index.html, for the same reason.
  rafHandle = requestAnimationFrame(fire);
  timeoutHandle = setTimeout(fire, 50);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Mount one block. `host` must already be in the document.
 *
 * spec: {
 *   url, resourcePath, mtlUrl, urlModifier,   // resolved by assets/index.html
 *   format, width, height,
 *   color, edgeColor, gridColor, bgColor, bgAlpha, themeSalt,
 *   edges, wireframe, grid, axes,
 *   azimuth, elevation, cameraDistance,
 *   srcKey,                                   // hash(fence source)|ordinal
 *   interactive,
 * }
 */
async function mount(host, spec) {
  if (!available()) {
    const err = new Error('no webgl');
    err.noWebgl = true;
    throw err;
  }

  const logical = clampSize(spec);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let entry;
  try {
    entry = await loadModel(spec, controller.signal);
  } finally {
    clearTimeout(timer);
  }

  const canvas = document.createElement('canvas');
  canvas.width = logical.w * SS;
  canvas.height = logical.h * SS;
  // Only the width is set inline: the stylesheet's height:auto then derives
  // the height from the intrinsic SS ratio, so max-width:100% SCALES the
  // figure in a narrow Marp column instead of squashing it.
  canvas.style.width = logical.w + 'px';
  host.appendChild(canvas);

  // Stamped so buildExportArtifact() can size the rasterized <img> WITHOUT
  // measuring: by export time __restoreMarpExportView() has run, and in deck
  // mode the live canvas sits in a display:none slide whose rect is 0x0.
  host.setAttribute('data-model3d-w', String(logical.w));
  host.setAttribute('data-model3d-h', String(logical.h));

  const built = buildScene(entry, spec, logical);
  const rec = {
    host,
    canvas,
    ctx: canvas.getContext('2d'),
    logical,
    scene: built.scene,
    camera: built.camera,
    radius: built.radius,
    controls: null,
    srcKey: spec.srcKey || hashString(spec.url),
    themeSalt: spec.themeSalt || '',
    bgColor: spec.bgColor || '#000000',
    bgAlpha: (spec.bgAlpha === undefined) ? 0 : Number(spec.bgAlpha),
    dirty: true,
  };

  // Restore the camera the user left this block at, so a keystroke elsewhere
  // in the document does not snap every figure back to its default view.
  const saved = cameraStates.get(cameraKeyOf(rec));
  if (saved) {
    rec.camera.position.set(saved.px, saved.py, saved.pz);
    rec.camera.lookAt(saved.tx, saved.ty, saved.tz);
  }

  if (spec.interactive) {
    const controls = new OrbitControls(rec.camera, canvas);
    // Damping mandates a continuous rAF loop, which is precisely what the
    // on-demand design exists to avoid.
    controls.enableDamping = false;
    controls.enablePan = false;
    if (saved) controls.target.set(saved.tx, saved.ty, saved.tz);
    controls.addEventListener('change', () => {
      const p = rec.camera.position;
      const t = controls.target;
      lruSet(cameraStates, cameraKeyOf(rec), {
        px: p.x, py: p.y, pz: p.z, tx: t.x, ty: t.y, tz: t.z,
      }, CAMERA_STATE_MAX);
      rec.dirty = true;
      scheduleRender();
    });
    controls.update();
    rec.controls = controls;
  }

  blocks.push(rec);
  renderBlock(rec);
}

function unmountAll() {
  // Runs on EVERY render, including documents with no model3d block at all.
  if (blocks.length === 0) {
    if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = 0; }
    if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = 0; }
    return;
  }
  if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = 0; }
  if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = 0; }

  for (const rec of blocks) {
    if (rec.controls) {
      // The leak is NOT the listeners on the canvas — those die with the node.
      // It is that OrbitControls attaches pointermove/pointerup/pointercancel
      // on domElement.ownerDocument DURING A DRAG: if a keystroke rebuilds
      // #preview mid-drag, those document-level listeners survive holding a
      // closure over the dead canvas, camera and scene. One retained graph per
      // keystroke is exactly the "freezes after a few minutes" symptom.
      try { rec.controls.dispose(); } catch (e) {}
      rec.controls = null;
    }
    if (rec.canvas) {
      // ~5MB per canvas; six blocks regenerating every 150ms is ~200MB/s of
      // garbage. Leaving that to GC is felt as a stutter.
      try { rec.canvas.width = 0; rec.canvas.height = 0; } catch (e) {}
    }
    // Materials and geometries belong to the LRUs (shared, still referenced),
    // so they are NOT disposed here — only the per-block scene graph is
    // dropped so it stops being reachable from this module.
    rec.scene = null;
    rec.camera = null;
    rec.ctx = null;
    rec.canvas = null;
    rec.host = null;
  }
  blocks = [];
}

function invalidate() {
  bitmapCache.clear();
  clearModelCache();
}

export {
  available,
  mount,
  unmountAll,
  flushNow,
  invalidate,
  SUPPORTED as supportedFormats,
  DEFAULT_W as defaultWidth,
  DEFAULT_H as defaultHeight,
  MAX_BYTES as maxBytes,
  hashString,
};

// Diagnostics only — deliberately not wired to any UI, mirroring
// Kataskeve3D._debug.clearRenderCache().
export const _debug = {
  stats() {
    return {
      blocks: blocks.length,
      models: modelCache.size,
      bitmaps: bitmapCache.size,
      materials: materialCache.size,
      cameras: cameraStates.size,
      programs: renderer ? renderer.info.programs.length : 0,
      contexts: renderer ? 1 : 0,
      rendererSize: [rendererW, rendererH],
      pendingRaf: !!rafHandle,
      pendingTimeout: !!timeoutHandle,
    };
  },
  clearCaches() { invalidate(); materialCache.clear(); cameraStates.clear(); },
  destroyRenderer,
};
