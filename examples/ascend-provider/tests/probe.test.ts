import { describe, expect, it } from 'vitest';
import { loadPreset, matchesPreset } from '../src/preset';
import {
  buildClangdArgs,
  parseCc1,
  pickPasses,
  sanitizeArgs,
} from '../src/probe';

const preset = loadPreset(new URL('../preset.yaml', import.meta.url).pathname);

const stderr = [
  '"bisheng" -cc1 -triple x86_64-unknown-linux-gnu -fcce-is-host -I/inc -o /tmp/p/probe-dav-c220.o -x asc probe.cpp',
  '"bisheng" -cc1 -triple hiipu64-hisilicon-cce -fcce-is-aicore -fcce-aicore-arch dav-c220-cube -I/inc -o /tmp/p/probe-dav-c220-cube.o probe.cpp',
  '"bisheng" -cc1 -triple hiipu64-hisilicon-cce -fcce-is-aicore -fcce-aicore-arch dav-c220-vec -I/inc -o /tmp/p/probe-dav-c220-vec.o probe.cpp',
].join('\n');

describe('probe parsing', () => {
  it('parses host and aicore commands', () => {
    const commands = parseCc1(stderr);
    expect(commands).toHaveLength(3);
    expect(commands[0].isHost).toBe(true);
    expect(commands[1].isAicore).toBe(true);
    expect(commands[1].arch).toBe('dav-c220-cube');
  });

  it('picks cube and vec passes from output suffixes', () => {
    const passes = pickPasses(parseCc1(stderr), preset);
    expect(passes.map((p) => p.name)).toEqual(['AIC', 'AIV']);
  });

  it('sanitizes driver args and adds macros', () => {
    const entry = {
      directory: '/w',
      file: '/w/k.cpp',
      arguments: ['bisheng', '-xasc', '--npu-arch=dav-2201', '-I/inc', '-c', '/w/k.cpp'],
    };
    const pass = pickPasses(parseCc1(stderr), preset)[0];
    const args = buildClangdArgs(entry, pass, preset);
    expect(args).toContain('-x');
    expect(args).toContain('c++');
    expect(args).toContain('-I/inc');
    expect(args).toContain('-D__DAV_CUBE__=1');
    expect(args).toContain('-D__gm__=');
    expect(args).not.toContain('-xasc');
    expect(args).not.toContain('--npu-arch=dav-2201');
    expect(sanitizeArgs(entry.arguments, preset)).not.toContain('-xasc');
  });
});

describe('preset matching', () => {
  it('matches joined and separated -x forms', () => {
    const base = { directory: '/w', file: '/w/k.cpp' };
    expect(
      matchesPreset({ ...base, arguments: ['bisheng', '-xasc', '-c', '/w/k.cpp'] }, preset),
    ).toBe(true);
    expect(
      matchesPreset({ ...base, arguments: ['bisheng', '-x', 'asc', '-c', '/w/k.cpp'] }, preset),
    ).toBe(true);
    expect(
      matchesPreset({ ...base, arguments: ['bisheng', '-x', 'cce', '-c', '/w/k.cpp'] }, preset),
    ).toBe(true);
    expect(
      matchesPreset({ ...base, arguments: ['g++', '-c', '/w/k.cpp'] }, preset),
    ).toBe(false);
  });

  it('matches compiler basenames against globs', () => {
    const entry = {
      directory: '/w',
      file: '/w/k.cpp',
      arguments: ['/opt/Ascend/bin/bisheng', '-xasc', '-c', '/w/k.cpp'],
    };
    expect(matchesPreset(entry, preset)).toBe(true);
  });
});

describe('sanitize', () => {
  it('removes separated -x forms and appends add args', () => {
    const args = [
      'bisheng',
      '-x',
      'cce',
      '--cce-auto-sync',
      '--npu-arch=dav-2201',
      '-c',
      'k.cpp',
    ];
    expect(sanitizeArgs(args, preset)).toEqual(['bisheng', '-c', 'k.cpp', '-x', 'c++']);
  });
});
