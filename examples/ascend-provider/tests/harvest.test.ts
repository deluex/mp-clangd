import { describe, expect, it } from 'vitest';
import { harvestEntriesFromLog } from '../src/harvest';

const log = [
  'cd /w/build && /opt/cann/bin/bisheng -x cce --npu-arch=dav-2201 -I/w/include -c /w/k.cpp -o /w/build/k.o',
  'cd /w/build && /opt/cann/bin/bisheng -x cce --npu-arch=dav-2201 -I/w/include -c /w/k.cpp -o /w/build/k.o',
  'g++ -c /w/host.cpp -o /w/host.o',
].join('\n');

describe('harvestEntriesFromLog', () => {
  it('extracts and dedupes bisheng entries', () => {
    const entries = harvestEntriesFromLog(log, '/fallback');
    expect(entries).toHaveLength(1);
    expect(entries[0].file).toBe('/w/k.cpp');
    expect(entries[0].arguments).toContain('-x');
    expect(entries[0].arguments).toContain('cce');
  });

  it('uses the cd directory when present', () => {
    const entries = harvestEntriesFromLog(log, '/fallback');
    expect(entries[0].directory).toBe('/w/build');
  });
});

describe('harvestEntriesFromLog edge cases', () => {
  it('falls back to the default directory without a cd prefix', () => {
    const entries = harvestEntriesFromLog('bisheng -x cce -c /w/k.cpp', '/fallback');
    expect(entries).toHaveLength(1);
    expect(entries[0].directory).toBe('/fallback');
    expect(entries[0].file).toBe('/w/k.cpp');
  });

  it('resolves relative sources against the cd directory', () => {
    const entries = harvestEntriesFromLog('cd /w/src && bisheng -c k.cpp', '/fallback');
    expect(entries[0].directory).toBe('/w/src');
    expect(entries[0].file).toBe('/w/src/k.cpp');
  });

  it('accepts ccec and requires -c or -x', () => {
    const lines = ['/opt/cann/bin/ccec -c /w/a.cpp', 'bisheng -E /w/b.cpp'];
    const entries = harvestEntriesFromLog(lines.join('\n'), '/w');
    expect(entries.map((entry) => entry.file)).toEqual(['/w/a.cpp']);
  });

  it('skips the -o value when locating the source after -c', () => {
    const entries = harvestEntriesFromLog(
      'bisheng -x cce -c -o /w/build/k.o -I/w/include /w/k.cpp',
      '/w',
    );
    expect(entries[0].file).toBe('/w/k.cpp');
  });

  it('falls back to the last source token when -c has no source argument', () => {
    const entries = harvestEntriesFromLog('bisheng -x cce -o /w/build/k.o /w/k.cpp', '/w');
    expect(entries[0].file).toBe('/w/k.cpp');
  });

  it('ignores non-compiler commands and empty lines', () => {
    const entries = harvestEntriesFromLog(
      ['', 'cd /w && make -j8', '/opt/cann/bin/clang -c /w/host.cpp'].join('\n'),
      '/fallback',
    );
    expect(entries).toEqual([]);
  });
});
