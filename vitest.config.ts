import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The extension sources import the `vscode` module; tests run headlessly
// against the committed stub harness.
const stubVscode = fileURLToPath(
  new URL('./packages/vscode-extension/tests/stub-vscode.ts', import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: {
      vscode: stubVscode,
    },
  },
  test: {
    include: ['packages/*/tests/**/*.test.ts', 'examples/*/tests/**/*.test.ts'],
    testTimeout: 20000,
  },
});
