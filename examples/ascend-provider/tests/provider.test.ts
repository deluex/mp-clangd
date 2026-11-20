import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CompileEntry, ProfileSet } from '@mp-clangd/core';
import { loadPreset } from '../src/preset';
import { buildAscendProfileSet, probeEntry } from '../src/provider';

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
  { name: 'AIC', argv: ['bisheng', '-cc1', '-fcce-is-aicore', '-fcce-aicore-arch', 'dav-c220-cube'] },
  { name: 'AIV', argv: ['bisheng', '-cc1', '-fcce-is-aicore', '-fcce-aicore-arch', 'dav-c220-vec'] },
];

describe('buildAscendProfileSet', () => {
  it('emits one profile per pass and keeps non-matching entries', async () => {
    const out = await buildAscendProfileSet(base, preset, probe, '/tmp/cache');
    expect(out.profiles.map((p) => p.id)).toEqual(['base/AIC', 'base/AIV']);
    expect(out.profiles[0].entries.map((e) => e.file)).toEqual(['/w/host.cpp', '/w/k.cpp']);
    expect(out.profiles[0].entries[1].arguments).toContain('-D__DAV_CUBE__=1');
    expect(out.profiles[1].entries[1].arguments).toContain('-D__DAV_VEC__=1');
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
          { name: 'AIC', argv: ['bisheng', '-cc1'] },
          { name: 'AIV', argv: ['bisheng', '-cc1'] },
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
});

describe('probeEntry', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('runs the compiler with -v -c and parses the per-pass cc1 commands', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-probe-'));
    const capture = join(dir, 'capture.json');
    const compiler = join(dir, 'fake-bisheng.mjs');
    writeFileSync(
      compiler,
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }));`,
        'const args = process.argv.slice(2);',
        "const out = args[args.indexOf('-o') + 1];",
        "const cube = out.replace(/\\.o$/, '-dav-c220-cube.o');",
        "const vec = out.replace(/\\.o$/, '-dav-c220-vec.o');",
        "console.error('\"' + process.argv[1] + '\" -cc1 -triple hiipu64-hisilicon-cce -fcce-is-aicore -fcce-aicore-arch dav-c220-cube -o ' + cube + ' k.cpp');",
        "console.error('\"' + process.argv[1] + '\" -cc1 -triple hiipu64-hisilicon-cce -fcce-is-aicore -fcce-aicore-arch dav-c220-vec -o ' + vec + ' k.cpp');",
      ].join('\n'),
      'utf8',
    );
    const entry: CompileEntry = {
      directory: dir,
      file: join(dir, 'k.cpp'),
      arguments: [
        process.execPath,
        compiler,
        '-xasc',
        '--npu-arch=dav-2201',
        '-c',
        'k.cpp',
        '-o',
        'k.o',
      ],
    };
    const cacheDir = join(dir, '.mpclangd', 'cache');

    const passes = await probeEntry(entry, preset, cacheDir);

    expect(passes.map((pass) => pass.name)).toEqual(['AIC', 'AIV']);
    expect(passes.map((pass) => pass.arch)).toEqual(['dav-c220-cube', 'dav-c220-vec']);

    const invocation = JSON.parse(readFileSync(capture, 'utf8')) as {
      cwd: string;
      argv: string[];
    };
    expect(invocation.cwd).toBe(dir);
    expect(invocation.argv).not.toContain('k.o');
    expect(invocation.argv.filter((arg) => arg === '-o')).toHaveLength(1);
    expect(invocation.argv.slice(-4, -1)).toEqual(['-v', '-c', '-o']);
    const tempOut = invocation.argv[invocation.argv.length - 1];
    expect(dirname(tempOut)).toBe(join(cacheDir, 'probe'));
    expect(tempOut.endsWith('.o')).toBe(true);

    expect(entry.arguments).toContain('k.o');
  });
});
