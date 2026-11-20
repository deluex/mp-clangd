import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StateStore, entryKey } from '@mp-clangd/core';
import { runCli } from '../src/commands';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function makeWorkspace() {
  dir = mkdtempSync(join(tmpdir(), 'mp-clangd-cli-'));
  mkdirSync(join(dir, 'build'), { recursive: true });
  writeFileSync(join(dir, 'build/compile_commands.json'), JSON.stringify([{
    directory: join(dir, 'build'),
    file: join(dir, 'a.cpp'),
    arguments: ['clang++', '-c', join(dir, 'a.cpp'), '-o', join(dir, 'build/a.o')],
  }]));
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { cwd: dir!, stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) },
    out,
    err,
  };
}

describe('cli', () => {
  it('init creates .mpclangd and updates .gitignore', async () => {
    makeWorkspace();
    expect(await runCli(['init'], io().io)).toBe(0);
    expect(readFileSync(join(dir!, '.gitignore'), 'utf8')).toContain('.mpclangd/');
  });

  it('refresh writes profiles.json and compile_commands.json', async () => {
    makeWorkspace();
    const { io: stream } = io();
    expect(await runCli(['refresh'], stream)).toBe(0);
    const profiles = JSON.parse(readFileSync(join(dir!, '.mpclangd/profiles.json'), 'utf8'));
    expect(profiles.profiles[0].id).toBe('build');
    const cdb = JSON.parse(readFileSync(join(dir!, '.mpclangd/compile_commands.json'), 'utf8'));
    expect(cdb[0].file).toBe(join(dir!, 'a.cpp'));
  });

  it('profile selects and persists a profile', async () => {
    makeWorkspace();
    expect(await runCli(['profile', 'build'], io().io)).toBe(0);
    const state = JSON.parse(readFileSync(join(dir!, '.mpclangd/state.json'), 'utf8'));
    expect(state.activeProfile).toBe('build');
  });

  it('doctor reports a missing clangd argument', async () => {
    makeWorkspace();
    const { io: stream, out } = io();
    expect(await runCli(['doctor'], stream)).toBe(0);
    expect(out.join('\n')).toContain('missing');
  });

  it('propagates a unit switch to header roots on refresh', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-cli-'));
    mkdirSync(join(dir, 'build'), { recursive: true });
    const source = join(dir, 'a.cpp');
    const header = join(dir, 'a.h');
    const unitA = {
      directory: join(dir, 'build'),
      file: source,
      arguments: ['clang++', '-DA=1', '-c', source, '-o', 'a.o'],
    };
    const unitB = {
      directory: join(dir, 'build'),
      file: source,
      arguments: ['clang++', '-DB=1', '-c', source, '-o', 'b.o'],
    };
    writeFileSync(join(dir, 'build/compile_commands.json'), JSON.stringify([unitA, unitB]));

    const store = StateStore.load(dir);
    store.setActiveProfile('build');
    store.setUnitKey('build', source, entryKey(unitA));
    store.setHeaderRoot('build', header, { rootFile: source, unitKey: entryKey(unitA) });
    store.save();

    const { io: stream } = io();
    expect(await runCli(['unit', 'a.cpp', 'B=1'], stream)).toBe(0);
    expect(await runCli(['refresh'], stream)).toBe(0);

    const reloaded = StateStore.load(dir);
    expect(reloaded.getHeaderRoot('build', header)).toEqual({
      rootFile: source,
      unitKey: entryKey(unitB),
    });
    const cdb = JSON.parse(
      readFileSync(join(dir, '.mpclangd/compile_commands.json'), 'utf8'),
    ) as Array<{ file: string; arguments: string[] }>;
    const headerEntry = cdb.find((entry) => entry.file === header);
    expect(headerEntry?.arguments).toContain('-DB=1');
    expect(headerEntry?.arguments).not.toContain('-DA=1');
    const sourceEntry = cdb.find((entry) => entry.file === source);
    expect(sourceEntry?.arguments).toContain('-DB=1');
  });

  it('doctor reports provider status and continues after a failure', async () => {
    makeWorkspace();
    const failScript = join(dir!, 'fail-provider.mjs');
    writeFileSync(failScript, 'process.stderr.write("boom"); process.exit(3);');
    writeFileSync(join(dir!, 'mp_clangd.yaml'), [
      'providers:',
      '  - use: builtin:cdb',
      '  - use: command',
      '    command:',
      `      - ${JSON.stringify(process.execPath)}`,
      `      - ${JSON.stringify(failScript)}`,
    ].join('\n'));

    const { io: stream, out } = io();
    expect(await runCli(['doctor'], stream)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('provider builtin:cdb: ok');
    expect(text).toContain('provider command: failed -');
    expect(text).toContain('boom');
    expect(text).toContain('missing');
  });
});
