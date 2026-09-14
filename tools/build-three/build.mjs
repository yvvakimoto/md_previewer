import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outfile = resolve(here, '..', '..', 'assets', 'libs', 'three', 'three.iife.js');

await build({
  entryPoints: [resolve(here, 'entry.js')],
  bundle: true,
  format: 'iife',
  globalName: 'Model3D',
  outfile,
  minify: true,
  target: ['chrome110'],
  legalComments: 'none',
  // three.core.js carries ~20 lines of non-ASCII source. esbuild's default
  // escapes those to \uXXXX, roughly tripling those bytes for nothing —
  // index.html is already served as UTF-8. (The other build-* projects have no
  // non-ASCII input, which is why only this one sets it.)
  charset: 'utf8',
  logLevel: 'info',
});

console.log('built ->', outfile);
