import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
});
