import { describe, expect, it } from 'vitest';
import {
  ProfileSetError,
  mergeProfileSets,
  parseProfileSet,
} from '../src/index';

describe('parseProfileSet', () => {
  it('resolves a relative file against its directory', () => {
    const set = parseProfileSet({
      profiles: [{
        id: 'default',
        entries: [{
          directory: '/work',
          file: 'src/a.cpp',
          arguments: ['clang++', '-c', 'src/a.cpp'],
        }],
      }],
    });
    expect(set.profiles[0].entries[0].file).toBe('/work/src/a.cpp');
  });

  it('rejects duplicate profile ids', () => {
    const input = {
      profiles: [
        { id: 'x', entries: [] },
        { id: 'x', entries: [] },
      ],
    };
    expect(() => parseProfileSet(input)).toThrow(ProfileSetError);
  });

  it('rejects entries without arguments', () => {
    const input = {
      profiles: [{ id: 'x', entries: [{ directory: '/w', file: '/w/a.cpp', arguments: [] }] }],
    };
    expect(() => parseProfileSet(input)).toThrow(ProfileSetError);
  });

  it('rejects a relative directory', () => {
    const input = {
      profiles: [{ id: 'x', entries: [{ directory: '.', file: 'a.cpp', arguments: ['clang++'] }] }],
    };
    expect(() => parseProfileSet(input)).toThrow(ProfileSetError);
  });

  it('preserves the optional unverified flag', () => {
    const set = parseProfileSet({
      profiles: [{
        id: 'x',
        entries: [
          { directory: '/w', file: 'a.cpp', arguments: ['clang++'], unverified: true },
          { directory: '/w', file: 'b.cpp', arguments: ['clang++'], unverified: false },
        ],
      }],
    });
    expect(set.profiles[0].entries[0].unverified).toBe(true);
    expect(set.profiles[0].entries[1].unverified).toBe(false);

    const merged = mergeProfileSets([set]);
    expect(merged.profiles[0].entries[0].unverified).toBe(true);
    expect(merged.profiles[0].entries[1].unverified).toBe(false);
  });

  it('rejects a non-boolean unverified flag', () => {
    const input = {
      profiles: [{
        id: 'x',
        entries: [{ directory: '/w', file: 'a.cpp', arguments: ['clang++'], unverified: 'yes' }],
      }],
    };
    expect(() => parseProfileSet(input)).toThrow(/unverified must be a boolean/);
  });
});

describe('mergeProfileSets', () => {
  it('merges distinct profiles in order', () => {
    const a = parseProfileSet({ profiles: [{ id: 'a', entries: [] }] });
    const b = parseProfileSet({ profiles: [{ id: 'b', entries: [] }] });
    expect(mergeProfileSets([a, b]).profiles.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('throws on conflicting ids', () => {
    const a = parseProfileSet({ profiles: [{ id: 'a', entries: [] }] });
    const b = parseProfileSet({ profiles: [{ id: 'a', entries: [] }] });
    expect(() => mergeProfileSets([a, b])).toThrow(ProfileSetError);
  });
});
