// Renderer bundle (esbuild JS API instead of the CLI) purely so the app version
// has ONE source of truth: package.json "version" is injected as __APP_VERSION__.
// The renderer keeps a literal fallback for bundles built without this define.
// Flags below must stay identical to the old `build:renderer` CLI invocation.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
if (typeof version !== 'string' || !version) throw new Error('package.json has no "version"');

await build({
  absWorkingDir: root,
  entryPoints: ['renderer/src/app.ts'],
  bundle: true,
  platform: 'browser',
  outfile: 'renderer/dist/app.js',
  format: 'iife',
  loader: { '.png': 'dataurl', '.svg': 'dataurl' },
  define: { __APP_VERSION__: JSON.stringify(version) },
});
