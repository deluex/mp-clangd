import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ProviderError,
  loadConfig,
  registerProvider,
  resetProviders,
  runProviders,
} from '../src/index';

let dir: string | undefined;
beforeEach(() => resetProviders());
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('loadConfig', () => {
  it('defaults to builtin:cdb', () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-cfg-'));
    expect(loadConfig(dir).providers).toEqual([{ use: 'builtin:cdb' }]);
  });

  it('parses mp_clangd.yaml', () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-cfg-'));
    writeFileSync(join(dir, 'mp_clangd.yaml'), 'providers:\n  - use: command\n    command: ["node", "p.mjs"]\n');
    expect(loadConfig(dir).providers[0]).toEqual({ use: 'command', command: ['node', 'p.mjs'] });
  });

  it('rejects a non string-array command', () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-cfg-'));
    writeFileSync(join(dir, 'mp_clangd.yaml'), 'providers:\n  - use: command\n    command: "node"\n');
    expect(() => loadConfig(dir!)).toThrow(/command must be an array of strings/);
  });
});

describe('runProviders', () => {
  it('merges builtin and command provider output', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-cfg-'));
    registerProvider('builtin:cdb', async () => ({ profiles: [{ id: 'a', entries: [] }] }));
    const script = join(dir, 'p.mjs');
    writeFileSync(script, `console.log(JSON.stringify({ profiles: [{ id: 'b', entries: [{ directory: '${dir}', file: '${join(dir, 'x.cpp')}', arguments: ['clang++'] }] }] }))`);
    const set = await runProviders(dir, {
      providers: [
        { use: 'builtin:cdb' },
        { use: 'command', command: [process.execPath, script] },
      ],
    });
    expect(set.profiles.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('reports a readable error when a command provider fails', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-cfg-'));
    registerProvider('builtin:cdb', async () => ({ profiles: [] }));
    const script = join(dir, 'bad.mjs');
    writeFileSync(script, 'process.stderr.write("boom"); process.exit(3);');
    await expect(runProviders(dir, {
      providers: [{ use: 'command', command: [process.execPath, script] }],
    })).rejects.toBeInstanceOf(ProviderError);
  });

  it('includes stderr in the command provider error', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-cfg-'));
    const script = join(dir, 'bad.mjs');
    writeFileSync(script, 'process.stderr.write("boom-detail"); process.exit(2);');
    await expect(runProviders(dir, {
      providers: [{ use: 'command', command: [process.execPath, script] }],
    })).rejects.toThrow(/boom-detail/);
  });

  it('substitutes {workspace} and reads the configured output file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-cfg-'));
    const script = join(dir, 'gen.mjs');
    writeFileSync(script, [
      "import { writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const target = process.argv[2];",
      "writeFileSync(join(target, 'profiles.json'), JSON.stringify({ profiles: [{ id: 'out', entries: [] }] }));",
    ].join('\n'));
    const set = await runProviders(dir, {
      providers: [{ use: 'command', command: [process.execPath, script, '{workspace}'], output: 'profiles.json' }],
    });
    expect(set.profiles.map((p) => p.id)).toEqual(['out']);
  });
});
