import { defineConfig } from 'tsup';

export default defineConfig({
  // tsup exposes this only through config, not the CLI. Bundling the workspace
  // packages keeps dist/main.js runnable without resolving their TS sources.
  noExternal: ['@mp-clangd/core', '@mp-clangd/provider-cdb'],
  // The bundled CJS dependencies expect `require`, which ESM does not provide.
  banner: {
    js: [
      "import { createRequire as __mpClangdCreateRequire } from 'node:module';",
      'const require = __mpClangdCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});
