import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildProfileSetFromCdbs,
  discoverCompileCommands,
  parseCdbFile,
} from '../src/index';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

describe('provider-cdb', () => {
  it('discovers CDBs and names profiles by relative directory', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-cdb-'));
    const cdb = join(dir, 'build/debug/compile_commands.json');
    writeJson(cdb, [{
      directory: join(dir, 'build/debug'),
      file: join(dir, 'src/a.cpp'),
      arguments: ['clang++', '-I', join(dir, 'include'), '-c', join(dir, 'src/a.cpp')],
    }]);
    const found = await discoverCompileCommands(dir, { include: ['build/**/compile_commands.json'] });
    expect(found).toEqual([cdb]);
    const set = await buildProfileSetFromCdbs(found, dir);
    expect(set.profiles.map((p) => p.id)).toEqual(['build/debug']);
    expect(set.profiles[0].entries[0].file).toBe(join(dir, 'src/a.cpp'));
  });

  it('parses command form with shell quoting', () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-cdb-'));
    const cdb = join(dir, 'compile_commands.json');
    writeJson(cdb, [{
      directory: dir,
      file: 'src/a.cpp',
      command: 'clang++ -I "inc dir" -c src/a.cpp -o a.o',
    }]);
    const entries = parseCdbFile(cdb);
    expect(entries[0].arguments).toEqual(['clang++', '-I', 'inc dir', '-c', 'src/a.cpp', '-o', 'a.o']);
    expect(entries[0].file).toBe(join(dir, 'src/a.cpp'));
  });

  it('resolves a relative file against directory, not cwd', () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-cdb-'));
    const cdb = join(dir, 'compile_commands.json');
    writeJson(cdb, [{
      directory: '/some/other/build',
      file: 'src/a.cpp',
      arguments: ['clang++', '-c', 'src/a.cpp'],
    }]);
    expect(parseCdbFile(cdb)[0].file).toBe('/some/other/build/src/a.cpp');
  });

  it('resolves a relative directory against the CDB file directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-cdb-'));
    const cdb = join(dir, 'compile_commands.json');
    writeJson(cdb, [{
      directory: '.',
      file: 'kernel.cpp',
      arguments: ['bisheng', '-xasc', '-c', 'kernel.cpp'],
    }]);
    expect(parseCdbFile(cdb)[0].file).toBe(join(dir, 'kernel.cpp'));
  });
});
