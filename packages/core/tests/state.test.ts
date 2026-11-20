import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StateStore, updateHeaderRootsForFile } from '../src/index';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('StateStore', () => {
  it('persists profile, unit and header history', () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-state-'));
    const store = StateStore.load(dir);
    store.setActiveProfile('p1');
    store.setUnitKey('p1', '/w/a.cpp', 'u1');
    store.setHeaderRoot('p1', '/w/h.h', { rootFile: '/w/a.cpp', unitKey: 'u1' });
    store.pushHeaderHistory('p1', '/w/h.h', { rootFile: '/w/a.cpp', unitKey: 'u1' });
    store.save();

    const again = StateStore.load(dir);
    expect(again.activeProfile).toBe('p1');
    expect(again.getUnitKey('p1', '/w/a.cpp')).toBe('u1');
    expect(again.getHeaderRoot('p1', '/w/h.h')).toEqual({ rootFile: '/w/a.cpp', unitKey: 'u1' });
    expect(again.getHeaderHistory('p1', '/w/h.h')).toHaveLength(1);
  });

  it('keeps histories per profile and header', () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-state-'));
    const store = StateStore.load(dir);
    store.pushHeaderHistory('p1', '/w/h.h', { rootFile: '/w/a.cpp', unitKey: 'u1' });
    store.pushHeaderHistory('p2', '/w/h.h', { rootFile: '/w/b.cpp', unitKey: 'u2' });
    expect(store.getHeaderHistory('p1', '/w/h.h')).toEqual([{ rootFile: '/w/a.cpp', unitKey: 'u1' }]);
    expect(store.getHeaderHistory('p2', '/w/h.h')).toEqual([{ rootFile: '/w/b.cpp', unitKey: 'u2' }]);
  });

  it('lists header roots for a single profile', () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-state-'));
    const store = StateStore.load(dir);
    store.setHeaderRoot('p1', '/w/a.h', { rootFile: '/w/a.cpp', unitKey: 'u1' });
    store.setHeaderRoot('p1', '/w/b.h', { rootFile: '/w/b.cpp', unitKey: 'u2' });
    store.setHeaderRoot('p2', '/w/c.h', { rootFile: '/w/c.cpp', unitKey: 'u3' });

    expect(store.listHeaderRoots('p1')).toEqual([
      { header: '/w/a.h', root: { rootFile: '/w/a.cpp', unitKey: 'u1' } },
      { header: '/w/b.h', root: { rootFile: '/w/b.cpp', unitKey: 'u2' } },
    ]);
    expect(store.listHeaderRoots('p2')).toEqual([
      { header: '/w/c.h', root: { rootFile: '/w/c.cpp', unitKey: 'u3' } },
    ]);
    expect(store.listHeaderRoots('missing')).toEqual([]);
  });

  it('repoints only the header roots that use the changed file', () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-state-'));
    const store = StateStore.load(dir);
    store.setHeaderRoot('p1', '/w/a.h', { rootFile: '/w/a.cpp', unitKey: 'u1' });
    store.setHeaderRoot('p1', '/w/b.h', { rootFile: '/w/a.cpp', unitKey: 'u1' });
    store.setHeaderRoot('p1', '/w/c.h', { rootFile: '/w/c.cpp', unitKey: 'u1' });
    store.setHeaderRoot('p2', '/w/d.h', { rootFile: '/w/a.cpp', unitKey: 'u1' });

    expect(updateHeaderRootsForFile(store, 'p1', '/w/a.cpp', 'u2')).toBe(2);
    expect(store.getHeaderRoot('p1', '/w/a.h')).toEqual({
      rootFile: '/w/a.cpp',
      unitKey: 'u2',
    });
    expect(store.getHeaderRoot('p1', '/w/b.h')).toEqual({
      rootFile: '/w/a.cpp',
      unitKey: 'u2',
    });
    expect(store.getHeaderRoot('p1', '/w/c.h')).toEqual({
      rootFile: '/w/c.cpp',
      unitKey: 'u1',
    });
    expect(store.getHeaderRoot('p2', '/w/d.h')).toEqual({
      rootFile: '/w/a.cpp',
      unitKey: 'u1',
    });
    expect(updateHeaderRootsForFile(store, 'p1', '/w/missing.cpp', 'u3')).toBe(0);
  });

  it('treats missing or corrupt state as empty', () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-state-'));
    const store = StateStore.load(dir);
    expect(store.path).toBe(join(dir, '.mpclangd', 'state.json'));
    expect(store.activeProfile).toBeUndefined();

    mkdirSync(join(dir, '.mpclangd'), { recursive: true });
    writeFileSync(join(dir, '.mpclangd', 'state.json'), '{not json');
    const corrupt = StateStore.load(dir);
    expect(corrupt.activeProfile).toBeUndefined();
    expect(corrupt.getHeaderHistory('p1', '/w/h.h')).toEqual([]);
  });

  it('dedupes history entries, moves repeats to the front and caps at 20', () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-clangd-state-'));
    const store = StateStore.load(dir);
    store.pushHeaderHistory('p1', '/w/h.h', { rootFile: '/w/a.cpp', unitKey: 'u1' });
    store.pushHeaderHistory('p1', '/w/h.h', { rootFile: '/w/b.cpp', unitKey: 'u2' });
    store.pushHeaderHistory('p1', '/w/h.h', { rootFile: '/w/a.cpp', unitKey: 'u1' });
    expect(store.getHeaderHistory('p1', '/w/h.h')).toEqual([
      { rootFile: '/w/a.cpp', unitKey: 'u1' },
      { rootFile: '/w/b.cpp', unitKey: 'u2' },
    ]);

    for (let i = 0; i < 25; i += 1) {
      store.pushHeaderHistory('p1', '/w/h.h', { rootFile: `/w/${i}.cpp`, unitKey: `u${i}` });
    }
    const history = store.getHeaderHistory('p1', '/w/h.h');
    expect(history).toHaveLength(20);
    expect(history[0]).toEqual({ rootFile: '/w/24.cpp', unitKey: 'u24' });
    expect(history[19]).toEqual({ rootFile: '/w/5.cpp', unitKey: 'u5' });
  });
});
