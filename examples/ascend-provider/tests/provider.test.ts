import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompileEntry, ProfileSet } from '@mp-clangd/core';
import { loadPreset } from '../src/preset';
import { buildAscendProfileSet, probeCacheKey, probeEntry } from '../src/provider';

const preset = loadPreset(new URL('../preset.yaml', import.meta.url).pathname);

const base = {
  profiles: [{
    id: 'base',
    entries: [
      { directory: '/w', file: '/w/k.cpp', arguments: ['bisheng', '-xasc', '--npu-arch=dav-2201', '-c', '/w/k.cpp'] },
      { directory: '/w', file: '/w/host.cpp', arguments: ['g++', '-c', '/w/host.cpp'] },
    ],
  }],
};

const probe = async (_entry: unknown, _preset: unknown) => [
  { name: 'AIC', argv: ['bisheng', '-cc1', '-fcce-is-aicore', '-fcce-aicore-arch', 'dav-c220-cube'], verified: true },
  { name: 'AIV', argv: ['bisheng', '-cc1', '-fcce-is-aicore', '-fcce-aicore-arch', 'dav-c220-vec'], verified: true },
];

describe('buildAscendProfileSet', () => {
  it('emits one profile per pass and keeps non-matching entries', async () => {
    const out = await buildAscendProfileSet(base, preset, probe, '/tmp/cache');
    expect(out.profiles.map((p) => p.id)).toEqual(['base/AIC', 'base/AIV']);
    expect(out.profiles[0].entries.map((e) => e.file)).toEqual(['/w/host.cpp', '/w/k.cpp']);
    expect(out.profiles[0].entries[1].arguments).toContain('-D__DAV_CUBE__=1');
    expect(out.profiles[1].entries[1].arguments).toContain('-D__DAV_VEC__=1');
    expect(out.profiles[0].entries[1].unverified).toBeUndefined();
  });

  it('keeps a profile unchanged when no entry matches the preset', async () => {
    let calls = 0;
    const hostOnly: ProfileSet = {
      profiles: [{
        id: 'host',
        entries: [{ directory: '/w', file: '/w/host.cpp', arguments: ['g++', '-c', '/w/host.cpp'] }],
      }],
    };
    const out = await buildAscendProfileSet(
      hostOnly,
      preset,
      async () => {
        calls += 1;
        return [];
      },
      '/tmp/cache',
    );
    expect(calls).toBe(0);
    expect(out.profiles.map((p) => p.id)).toEqual(['host']);
    expect(out.profiles[0].entries.map((e) => e.file)).toEqual(['/w/host.cpp']);
  });

  it('adds every probed entry to each pass profile and forwards the cache dir', async () => {
    const calls: Array<[string, string]> = [];
    const multiBase: ProfileSet = {
      profiles: [{
        id: 'base',
        entries: [
          { directory: '/w', file: '/w/a.cpp', arguments: ['bisheng', '-xasc', '-c', '/w/a.cpp'] },
          { directory: '/w', file: '/w/host.cpp', arguments: ['g++', '-c', '/w/host.cpp'] },
          { directory: '/w', file: '/w/b.cpp', arguments: ['bisheng', '-xasc', '-c', '/w/b.cpp'] },
        ],
      }],
    };
    const out = await buildAscendProfileSet(
      multiBase,
      preset,
      async (entry, _preset, cacheDir) => {
        calls.push([entry.file, cacheDir]);
        return [
          { name: 'AIC', argv: ['bisheng', '-cc1'], verified: true },
          { name: 'AIV', argv: ['bisheng', '-cc1'], verified: true },
        ];
      },
      '/cache/root',
    );
    expect(calls).toEqual([
      ['/w/a.cpp', '/cache/root'],
      ['/w/b.cpp', '/cache/root'],
    ]);
    expect(out.profiles.map((p) => p.id)).toEqual(['base/AIC', 'base/AIV']);
    expect(out.profiles[0].entries.map((e) => e.file)).toEqual([
      '/w/host.cpp',
      '/w/a.cpp',
      '/w/b.cpp',
    ]);
    expect(out.profiles[1].entries.map((e) => e.file)).toEqual([
      '/w/host.cpp',
      '/w/a.cpp',
      '/w/b.cpp',
    ]);
  });

  it('does not mutate the input profile set', async () => {
    await buildAscendProfileSet(base, preset, probe, '/tmp/cache');
    expect(base.profiles[0].id).toBe('base');
    expect(base.profiles[0].entries[0].arguments).toEqual([
      'bisheng',
      '-xasc',
      '--npu-arch=dav-2201',
      '-c',
      '/w/k.cpp',
    ]);
  });

  it('falls back to unverified entries when one probe throws and keeps the other entries', async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const mixedBase: ProfileSet = {
      profiles: [{
        id: 'base',
        entries: [
          { directory: '/w', file: '/w/good.cpp', arguments: ['bisheng', '-xasc', '-c', '/w/good.cpp'] },
          { directory: '/w', file: '/w/bad.cpp', arguments: ['bisheng', '-xasc', '-c', '/w/bad.cpp'] },
        ],
      }],
    };
    try {
      const out = await buildAscendProfileSet(
        mixedBase,
        preset,
        async (entry) => {
          if (entry.file.endsWith('bad.cpp')) {
            throw new Error('compiler exploded');
          }
          return [
            { name: 'AIC', argv: ['bisheng', '-cc1'], verified: true },
            { name: 'AIV', argv: ['bisheng', '-cc1'], verified: true },
          ];
        },
        '/tmp/cache',
      );
      expect(out.profiles.map((p) => p.id)).toEqual(['base/AIC', 'base/AIV']);
      const aic = out.profiles[0].entries;
      expect(aic.map((entry) => entry.file)).toEqual(['/w/good.cpp', '/w/bad.cpp']);
      expect(aic[0].unverified).toBeUndefined();
      expect(aic[0].arguments).toContain('-D__DAV_CUBE__=1');
      expect(aic[1].unverified).toBe(true);
      expect(aic[1].arguments).toContain('-D__DAV_CUBE__=1');
      expect(writes.join('')).toMatch(/probe failed .*bad\.cpp/);
    } finally {
      spy.mockRestore();
    }
  });
});

interface FakeCompilerOptions {
  capture?: string;
  counter?: string;
  macros?: 'full' | 'partial';
  padStderr?: boolean;
}

function writeFakeCompiler(dir: string, options: FakeCompilerOptions = {}): string {
  const script = join(dir, 'fake-bisheng.mjs');
  const lines = [
    '#!/usr/bin/env node',
    "import { appendFileSync, writeFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    "if (args.includes('-dM')) {",
    "  const arch = args[args.indexOf('-fcce-aicore-arch') + 1] ?? '';",
    "  const defines = ['#define __NPU_DEVICE__ 1'];",
    "  if (arch.endsWith('-cube')) {",
    "    defines.push('#define __DAV_CUBE__ 1', '#define __DAV_C220_CUBE__ 1');",
    '  } else {',
    "    defines.push('#define __DAV_VEC__ 1', '#define __DAV_C220_VEC__ 1');",
    '  }',
    options.macros === 'partial'
      ? "  process.stdout.write('#define __NPU_DEVICE__ 1\\n');"
      : "  process.stdout.write(defines.join('\\n') + '\\n');",
    '  process.exit(0);',
    '}',
  ];
  if (options.counter !== undefined) {
    lines.push(`appendFileSync(${JSON.stringify(options.counter)}, 'x');`);
  }
  if (options.capture !== undefined) {
    lines.push(
      `writeFileSync(${JSON.stringify(options.capture)}, JSON.stringify({ cwd: process.cwd(), argv: args }));`,
    );
  }
  if (options.padStderr === true) {
    lines.push("console.error('x'.repeat(2 * 1024 * 1024));");
  }
  lines.push(
    "const out = args[args.indexOf('-o') + 1];",
    "const cube = out.replace(/\\.o$/, '-dav-c220-cube.o');",
    "const vec = out.replace(/\\.o$/, '-dav-c220-vec.o');",
    "const prefix = JSON.stringify(process.argv[1]);",
    "console.error(prefix + ' -cc1 -triple hiipu64-hisilicon-cce -fcce-is-aicore -fcce-aicore-arch dav-c220-cube -o ' + cube + ' k.cpp');",
    "console.error(prefix + ' -cc1 -triple hiipu64-hisilicon-cce -fcce-is-aicore -fcce-aicore-arch dav-c220-vec -o ' + vec + ' k.cpp');",
  );
  writeFileSync(script, `${lines.join('\n')}\n`, 'utf8');
  chmodSync(script, 0o755);
  return script;
}

function makeEntry(dir: string, compiler: string, extraArguments: string[] = []): CompileEntry {
  return {
    directory: dir,
    file: join(dir, 'k.cpp'),
    arguments: [
      compiler,
      '-xasc',
      '--npu-arch=dav-2201',
      '-c',
      'k.cpp',
      '-o',
      'k.o',
      ...extraArguments,
    ],
  };
}

function probeDirectory(cacheDir: string): string {
  return join(cacheDir, 'probe');
}

describe('probeEntry', () => {
  let dir: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('runs the compiler with -v -c and verifies each pass with -dM', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-probe-'));
    const capture = join(dir, 'capture.json');
    const compiler = writeFakeCompiler(dir, { capture });
    const entry = makeEntry(dir, compiler);
    const cacheDir = join(dir, '.mpclangd', 'cache');

    const passes = await probeEntry(entry, preset, cacheDir);

    expect(passes.map((pass) => pass.name)).toEqual(['AIC', 'AIV']);
    expect(passes.map((pass) => pass.arch)).toEqual(['dav-c220-cube', 'dav-c220-vec']);
    expect(passes.map((pass) => pass.verified)).toEqual([true, true]);

    const invocation = JSON.parse(readFileSync(capture, 'utf8')) as {
      cwd: string;
      argv: string[];
    };
    expect(invocation.cwd).toBe(dir);
    expect(invocation.argv).not.toContain('k.o');
    expect(invocation.argv.filter((arg) => arg === '-o')).toHaveLength(1);
    expect(invocation.argv.slice(-4, -1)).toEqual(['-v', '-c', '-o']);
    const tempOut = invocation.argv[invocation.argv.length - 1];
    expect(basename(dirname(tempOut))).toMatch(/^run-/);
    expect(dirname(dirname(tempOut))).toBe(probeDirectory(cacheDir));
    expect(tempOut.endsWith('.o')).toBe(true);
    expect(existsSync(dirname(tempOut))).toBe(false);

    expect(entry.arguments).toContain('k.o');
  });

  it('accepts probe stderr larger than the default 1 MiB buffer', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-probe-'));
    const compiler = writeFakeCompiler(dir, { padStderr: true });
    const cacheDir = join(dir, '.mpclangd', 'cache');

    const passes = await probeEntry(makeEntry(dir, compiler), preset, cacheDir);
    expect(passes.map((pass) => pass.name)).toEqual(['AIC', 'AIV']);
    expect(passes.map((pass) => pass.verified)).toEqual([true, true]);
  });

  it('hits the probe cache and skips the compiler on the second call', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-probe-'));
    const counter = join(dir, 'counter.txt');
    const compiler = writeFakeCompiler(dir, { counter });
    const entry = makeEntry(dir, compiler);
    const cacheDir = join(dir, '.mpclangd', 'cache');

    const first = await probeEntry(entry, preset, cacheDir);
    expect(readFileSync(counter, 'utf8')).toHaveLength(1);

    const second = await probeEntry(entry, preset, cacheDir);
    expect(readFileSync(counter, 'utf8')).toHaveLength(1);
    expect(second.map((pass) => pass.name)).toEqual(first.map((pass) => pass.name));
    expect(second.map((pass) => pass.verified)).toEqual([true, true]);

    const cacheFiles = readdirSync(probeDirectory(cacheDir));
    expect(cacheFiles).toHaveLength(1);
    expect(cacheFiles[0]).toMatch(/^[0-9a-f]{40}\.json$/);
    const cached = JSON.parse(
      readFileSync(join(probeDirectory(cacheDir), cacheFiles[0]), 'utf8'),
    ) as { passes: Array<{ name: string; verified: boolean }> };
    expect(cached.passes).toEqual([
      { name: 'AIC', verified: true },
      { name: 'AIV', verified: true },
    ]);
    expect(JSON.stringify(cached)).not.toContain('.o');
  });

  it('removes the temporary probe directory and device objects', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-probe-'));
    const compiler = writeFakeCompiler(dir);
    const cacheDir = join(dir, '.mpclangd', 'cache');

    await probeEntry(makeEntry(dir, compiler), preset, cacheDir);

    const probeDir = probeDirectory(cacheDir);
    for (const name of readdirSync(probeDir)) {
      expect(name.endsWith('.json')).toBe(true);
      expect(statSync(join(probeDir, name)).isDirectory()).toBe(false);
    }
  });

  it('invalidates the cache when the key changes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-probe-'));
    const counter = join(dir, 'counter.txt');
    const compiler = writeFakeCompiler(dir, { counter });
    const cacheDir = join(dir, '.mpclangd', 'cache');

    await probeEntry(makeEntry(dir, compiler), preset, cacheDir);
    await probeEntry(makeEntry(dir, compiler, ['-DEXTRA=1']), preset, cacheDir);

    expect(readFileSync(counter, 'utf8')).toHaveLength(2);
    expect(readdirSync(probeDirectory(cacheDir))).toHaveLength(2);
  });

  it('marks passes unverified and falls back when -dM verification fails', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-probe-'));
    const compiler = writeFakeCompiler(dir, { macros: 'partial' });
    const entry = makeEntry(dir, compiler);
    const cacheDir = join(dir, '.mpclangd', 'cache');

    const passes = await probeEntry(entry, preset, cacheDir);
    expect(passes.map((pass) => pass.verified)).toEqual([false, false]);

    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const out = await buildAscendProfileSet(
        { profiles: [{ id: 'base', entries: [entry] }] },
        preset,
        probeEntry,
        cacheDir,
      );
      expect(out.profiles.map((p) => p.id)).toEqual(['base/AIC', 'base/AIV']);
      expect(out.profiles[0].entries[0].unverified).toBe(true);
      expect(out.profiles[0].entries[0].arguments).toContain('-D__DAV_CUBE__=1');
      expect(out.profiles[1].entries[0].unverified).toBe(true);
      expect(out.profiles[1].entries[0].arguments).toContain('-D__DAV_VEC__=1');
      expect(writes.join('')).toMatch(/probe verification failed/);
    } finally {
      spy.mockRestore();
    }
  });

  it('keys the cache by the PATH-resolved compiler and source mtimes', () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-probe-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const compiler = join(bin, 'my-bisheng');
    writeFileSync(compiler, '#!/bin/sh\n');
    const source = join(dir, 'k.cpp');
    writeFileSync(source, 'int x;\n');
    const entry: CompileEntry = {
      directory: dir,
      file: source,
      arguments: ['my-bisheng', '-c', 'k.cpp'],
    };

    const previousPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      const first = probeCacheKey(entry, 'my-bisheng');
      const later = new Date(Date.now() + 5000);
      utimesSync(compiler, later, later);
      const afterCompiler = probeCacheKey(entry, 'my-bisheng');
      expect(afterCompiler).not.toBe(first);

      const evenLater = new Date(Date.now() + 9000);
      utimesSync(source, evenLater, evenLater);
      expect(probeCacheKey(entry, 'my-bisheng')).not.toBe(afterCompiler);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it('emits verified entries without the unverified flag', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-probe-'));
    const compiler = writeFakeCompiler(dir);
    const entry = makeEntry(dir, compiler);
    const cacheDir = join(dir, '.mpclangd', 'cache');

    const out = await buildAscendProfileSet(
      { profiles: [{ id: 'base', entries: [entry] }] },
      preset,
      probeEntry,
      cacheDir,
    );
    expect(out.profiles.map((p) => p.id)).toEqual(['base/AIC', 'base/AIV']);
    expect(out.profiles[0].entries[0].unverified).toBeUndefined();
    expect(out.profiles[0].entries[0].arguments).toContain('-D__DAV_CUBE__=1');
    expect(out.profiles[1].entries[0].arguments).toContain('-D__DAV_VEC__=1');
  });
});
