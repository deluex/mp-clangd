import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StateStore } from '../src/index';

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
