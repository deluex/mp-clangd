import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageDir = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(packageDir, 'src/extension.ts')],
  outfile: path.join(packageDir, 'dist/extension.js'),
  bundle: true,
  external: ['vscode'],
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: true,
});
