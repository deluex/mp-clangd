import { describe, expect, it } from 'vitest';
import { deriveUnitLabel, entryKey, normalizeEntry, unitsForFile } from '../src/index';

const entryFor = (file: string, args: string[]) => normalizeEntry({
  directory: '/w',
  file,
  arguments: args,
});

const mk = (args: string[]) => entryFor('/w/k.cpp', args);

describe('unitsForFile', () => {
  it('dedupes identical entries and labels by differing define', () => {
    const entries = [
      mk(['bisheng', '-D__DAV_CUBE__', '-o', 'k-cube.o']),
      mk(['bisheng', '-D__DAV_CUBE__', '-o', 'k-cube.o']),
      mk(['bisheng', '-D__DAV_VEC__', '-o', 'k-vec.o']),
    ];
    const units = unitsForFile({ id: 'p', entries }, '/w/k.cpp');
    expect(units.map((u) => u.label)).toEqual(['__DAV_CUBE__', '__DAV_VEC__']);
    expect(units).toHaveLength(2);
    expect(units[0].key).toBe(entryKey(entries[0]));
  });

  it('falls back to the -o basename', () => {
    const entries = [
      mk(['clang++', '-c', 'k.cpp', '-o', 'out/a.o']),
      mk(['clang++', '-O2', '-c', 'k.cpp', '-o', 'out/b.o']),
    ];
    expect(unitsForFile({ id: 'p', entries }, '/w/k.cpp').map((u) => u.label))
      .toEqual(['a.o', 'b.o']);
  });

  it('returns only units for the requested file', () => {
    const entries = [
      mk(['clang++', '-o', 'k.o']),
      entryFor('/w/other.cpp', ['clang++', '-o', 'other.o']),
    ];
    const units = unitsForFile({ id: 'p', entries }, '/w/k.cpp');
    expect(units.map((u) => u.entry.file)).toEqual(['/w/k.cpp']);
  });
});

describe('normalizeEntry', () => {
  it('resolves a relative file against the entry directory', () => {
    expect(entryFor('src/a.cpp', ['clang++']).file).toBe('/w/src/a.cpp');
  });
});

describe('deriveUnitLabel', () => {
  it('ignores defines shared by every other entry', () => {
    const entries = [
      entryFor('/w/k.cpp', ['cc', '-DSHARED', '-DALPHA']),
      entryFor('/w/k.cpp', ['cc', '-DSHARED', '-DBETA']),
    ];
    expect(deriveUnitLabel(entries, entries[0])).toBe('ALPHA');
    expect(deriveUnitLabel(entries, entries[1])).toBe('BETA');
  });

  it('ignores a -o basename shared with another entry', () => {
    const entries = [
      entryFor('/w/k.cpp', ['cc', '-O2', '-o', 'out/k.o']),
      entryFor('/w/k.cpp', ['cc', '-O3', '-o', 'build/k.o']),
    ];
    expect(deriveUnitLabel(entries, entries[0])).toBe('unit 1');
    expect(deriveUnitLabel(entries, entries[1])).toBe('unit 2');
  });

  it('falls back to a positional label', () => {
    const entries = [
      entryFor('/w/k.cpp', ['cc', '-O2']),
      entryFor('/w/k.cpp', ['cc', '-O3']),
    ];
    expect(deriveUnitLabel(entries, entries[1])).toBe('unit 2');
  });
});
