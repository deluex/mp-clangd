import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  StateStore,
  entryKey,
  materialize,
  writeCompileCommands,
} from '../src/index';

const cube = {
  directory: '/w',
  file: '/w/k.cpp',
  arguments: ['bisheng', '-D__DAV_CUBE__', '-c', '/w/k.cpp', '-o', 'k-cube.o'],
};
const vec = {
  directory: '/w',
  file: '/w/k.cpp',
  arguments: ['bisheng', '-D__DAV_VEC__', '-c', '/w/k.cpp', '-o', 'k-vec.o'],
};
const other = {
  directory: '/w',
  file: '/w/b.cpp',
  arguments: ['clang++', '-c', '/w/b.cpp', '-o', 'b.o'],
};

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('materialize', () => {
  it('writes one entry per file using the selected unit', () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-mat-'));
    const state = StateStore.load(dir);
    state.setUnitKey('p', '/w/k.cpp', entryKey(vec));
    const out = materialize({
      profile: { id: 'p', entries: [cube, vec, other] },
      state,
      headerRoots: [],
    });
    expect(out.filter((e) => e.file === '/w/k.cpp')).toHaveLength(1);
    expect(out.find((e) => e.file === '/w/k.cpp')?.arguments).toContain('-D__DAV_VEC__');
    expect(out.find((e) => e.file === '/w/b.cpp')?.arguments).toContain('b.o');
  });

  it('replaces the source token for a header entry', () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-mat-'));
    const state = StateStore.load(dir);
    const out = materialize({
      profile: { id: 'p', entries: [cube] },
      state,
      headerRoots: [{ header: '/w/h.h', rootFile: '/w/k.cpp', unitKey: entryKey(cube) }],
    });
    const header = out.find((e) => e.file === '/w/h.h');
    expect(header?.arguments).toContain('/w/h.h');
    expect(header?.arguments).not.toContain('/w/k.cpp');
  });

  it('preserves unverified on the selected unit and its header entry', () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-mat-'));
    const fallback = {
      directory: '/w',
      file: '/w/k.cpp',
      arguments: ['bisheng', '-D__DAV_CUBE__=1', '-c', '/w/k.cpp'],
      unverified: true,
    };
    const state = StateStore.load(dir);
    state.setUnitKey('p', '/w/k.cpp', entryKey(fallback));
    const out = materialize({
      profile: { id: 'p', entries: [fallback] },
      state,
      headerRoots: [{ header: '/w/h.h', rootFile: '/w/k.cpp', unitKey: entryKey(fallback) }],
    });
    expect(out.find((e) => e.file === '/w/k.cpp')?.unverified).toBe(true);
    expect(out.find((e) => e.file === '/w/h.h')?.unverified).toBe(true);
  });

  it('replaces a relative source token for a header entry', () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-mat-'));
    const state = StateStore.load(dir);
    const relative = {
      directory: '/w',
      file: '/w/src/k.cpp',
      arguments: ['clang++', '-c', 'src/k.cpp', '-o', 'k.o'],
    };
    const out = materialize({
      profile: { id: 'p', entries: [relative] },
      state,
      headerRoots: [{ header: '/w/h.h', rootFile: '/w/src/k.cpp', unitKey: entryKey(relative) }],
    });
    const header = out.find((e) => e.file === '/w/h.h');
    expect(header?.arguments).toContain('/w/h.h');
    expect(header?.arguments).not.toContain('src/k.cpp');
  });
});

describe('writeCompileCommands', () => {
  it('writes .mpclangd/compile_commands.json', () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-mat-'));
    const file = writeCompileCommands(dir, [other]);
    expect(file).toBe(join(dir, '.mpclangd', 'compile_commands.json'));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([other]);
  });
});
