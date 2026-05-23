import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outfile = resolve(here, '..', '..', 'assets', 'libs', 'marp', 'marp.iife.js');

await build({
  entryPoints: [resolve(here, 'entry.js')],
  bundle: true,
  format: 'iife',
  globalName: 'MarpCore',
  outfile,
  minify: true,
  target: ['chrome110'],
  legalComments: 'none',
  logLevel: 'info',
});

console.log('built ->', outfile);
