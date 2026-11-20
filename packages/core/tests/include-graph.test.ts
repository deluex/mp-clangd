import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  IncludeGraphError,
  buildIncludeGraph,
  chooseRoot,
  extractIncludePaths,
} from '../src/index';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function write(file: string, text: string) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
}

describe('buildIncludeGraph', () => {
  it('finds every root chain for a header', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-inc-'));
    write(join(dir, 'main.cpp'), '#include "a.h"\n');
    write(join(dir, 'a.h'), '#include "b.h"\n');
    write(join(dir, 'b.h'), 'int b;\n');
    write(join(dir, 'other.cpp'), '#include "b.h"\n');
    const entries = [
      { directory: dir, file: join(dir, 'main.cpp'), arguments: ['clang++', '-I', dir, '-c', join(dir, 'main.cpp')] },
      { directory: dir, file: join(dir, 'other.cpp'), arguments: ['clang++', '-I', dir, '-c', join(dir, 'other.cpp')] },
    ];
    const graph = await buildIncludeGraph(entries, { workspaceDir: dir });
    const roots = graph.rootsFor(join(dir, 'b.h'));
    expect(roots.map((r) => r.chain)).toEqual([
      [join(dir, 'main.cpp'), join(dir, 'a.h'), join(dir, 'b.h')],
      [join(dir, 'other.cpp'), join(dir, 'b.h')],
    ]);
  });

  it('terminates on include cycles', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-inc-'));
    write(join(dir, 'main.cpp'), '#include "a.h"\n');
    write(join(dir, 'a.h'), '#include "b.h"\n');
    write(join(dir, 'b.h'), '#include "a.h"\n');
    const entries = [
      { directory: dir, file: join(dir, 'main.cpp'), arguments: ['clang++', '-I', dir, '-c', join(dir, 'main.cpp')] },
    ];
    const graph = await buildIncludeGraph(entries, { workspaceDir: dir });
    expect(graph.rootsFor(join(dir, 'a.h'))).toHaveLength(1);
  });

  it('uses -iquote for quoted includes and -isystem for angle includes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-inc-'));
    write(join(dir, 'main.cpp'), '#include "q.h"\n#include <s.h>\n#include <hidden.h>\n#include <local.h>\n');
    write(join(dir, 'local.h'), 'int local;\n');
    write(join(dir, 'quote', 'q.h'), 'int q;\n');
    write(join(dir, 'quote', 'hidden.h'), 'int hidden;\n');
    write(join(dir, 'system', 's.h'), 'int s;\n');
    const entries = [
      {
        directory: dir,
        file: join(dir, 'main.cpp'),
        arguments: [
          'clang++',
          '-iquote',
          join(dir, 'quote'),
          '-isystem',
          join(dir, 'system'),
          '-c',
          join(dir, 'main.cpp'),
        ],
      },
    ];
    const graph = await buildIncludeGraph(entries, { workspaceDir: dir });
    expect(graph.rootsFor(join(dir, 'quote', 'q.h'))).toHaveLength(1);
    expect(graph.rootsFor(join(dir, 'system', 's.h'))).toHaveLength(1);
    expect(graph.rootsFor(join(dir, 'quote', 'hidden.h'))).toEqual([]);
    expect(graph.rootsFor(join(dir, 'local.h'))).toEqual([]);
  });

  it('does not follow included files outside the workspace', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-inc-'));
    const workspace = join(dir, 'ws');
    write(join(dir, 'outside.h'), 'int outside;\n');
    write(join(workspace, 'main.cpp'), '#include "../outside.h"\n#include "link.h"\n');
    symlinkSync(join(dir, 'outside.h'), join(workspace, 'link.h'));
    const entries = [
      { directory: workspace, file: join(workspace, 'main.cpp'), arguments: ['clang++', '-c', join(workspace, 'main.cpp')] },
    ];
    const graph = await buildIncludeGraph(entries, { workspaceDir: workspace });
    expect(graph.rootsFor(join(dir, 'outside.h'))).toEqual([]);
    expect(graph.rootsFor(join(workspace, 'link.h'))).toEqual([]);
  });

  it('throws IncludeGraphError when maxFiles is exceeded', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-inc-'));
    write(join(dir, 'main.cpp'), '#include "a.h"\n');
    write(join(dir, 'a.h'), 'int a;\n');
    const entries = [
      { directory: dir, file: join(dir, 'main.cpp'), arguments: ['clang++', '-c', join(dir, 'main.cpp')] },
    ];
    await expect(
      buildIncludeGraph(entries, { workspaceDir: dir, maxFiles: 1 }),
    ).rejects.toBeInstanceOf(IncludeGraphError);
  });
});

describe('extractIncludePaths', () => {
  it('handles attached and separate include flags', () => {
    expect(
      extractIncludePaths([
        'clang++',
        '-Iinc',
        '-I',
        'inc2',
        '-isystem',
        'sys',
        '-isystemsys2',
        '-iquote',
        'q',
        '-iquoteq2',
        '-idirafter',
        'after',
        '-c',
        'x.cpp',
      ]),
    ).toEqual({
      quote: ['q', 'q2'],
      angle: ['inc', 'inc2', 'sys', 'sys2', 'after'],
    });
  });
});

describe('chooseRoot', () => {
  const paths = [
    { rootFile: '/w/a.cpp', chain: ['/w/a.cpp', '/w/h.h'] },
    { rootFile: '/w/b.cpp', chain: ['/w/b.cpp', '/w/h.h'] },
    { rootFile: '/w/c.cpp', chain: ['/w/c.cpp', '/w/h.h'] },
  ];
  it('prefers the navigation origin', () => {
    expect(chooseRoot(paths, { originFile: '/w/c.cpp' })?.rootFile).toBe('/w/c.cpp');
  });
  it('falls back to history order', () => {
    expect(chooseRoot(paths, { history: ['/w/b.cpp'] })?.rootFile).toBe('/w/b.cpp');
  });
  it('falls back to alphabetical order', () => {
    expect(chooseRoot(paths, {})?.rootFile).toBe('/w/a.cpp');
  });
  it('prefers origin over history and history over alphabet', () => {
    expect(
      chooseRoot(paths, { originFile: '/w/c.cpp', history: ['/w/b.cpp'] })?.rootFile,
    ).toBe('/w/c.cpp');
    expect(
      chooseRoot(paths, { history: ['/w/missing.cpp', '/w/c.cpp', '/w/b.cpp'] })?.rootFile,
    ).toBe('/w/c.cpp');
  });
  it('returns undefined without candidates', () => {
    expect(chooseRoot([], {})).toBeUndefined();
  });
});
