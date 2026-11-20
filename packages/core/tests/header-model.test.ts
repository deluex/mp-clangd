import { describe, expect, it } from 'vitest';
import { buildHeaderTreeModel } from '../src/index';
import type { IncludeGraph, RootPath } from '../src/index';

function graphOf(paths: RootPath[]): IncludeGraph {
  return { rootsFor: () => paths };
}

describe('buildHeaderTreeModel', () => {
  it('groups chains by root and orders roots by history', () => {
    const graph = {
      rootsFor: () => [
        { rootFile: '/w/a.cpp', chain: ['/w/a.cpp', '/w/h.h'] },
        { rootFile: '/w/b.cpp', chain: ['/w/b.cpp', '/w/mid.h', '/w/h.h'] },
      ],
    };
    const model = buildHeaderTreeModel(graph, '/w/h.h', ['/w/b.cpp']);
    expect(model.map((i) => i.rootFile)).toEqual(['/w/b.cpp', '/w/a.cpp']);
    expect(model[0].chains).toEqual([['/w/b.cpp', '/w/mid.h', '/w/h.h']]);
  });

  it('orders remaining roots alphabetically and keeps every chain per root', () => {
    const model = buildHeaderTreeModel(
      graphOf([
        { rootFile: '/w/z.cpp', chain: ['/w/z.cpp', '/w/h.h'] },
        { rootFile: '/w/b.cpp', chain: ['/w/b.cpp', '/w/one.h', '/w/h.h'] },
        { rootFile: '/w/a.cpp', chain: ['/w/a.cpp', '/w/h.h'] },
        { rootFile: '/w/b.cpp', chain: ['/w/b.cpp', '/w/two.h', '/w/h.h'] },
      ]),
      '/w/h.h',
      ['/w/z.cpp'],
    );
    expect(model.map((i) => i.rootFile)).toEqual(['/w/z.cpp', '/w/a.cpp', '/w/b.cpp']);
    expect(model[2].chains).toEqual([
      ['/w/b.cpp', '/w/one.h', '/w/h.h'],
      ['/w/b.cpp', '/w/two.h', '/w/h.h'],
    ]);
  });

  it('puts history roots first in history order and ignores unknown entries', () => {
    const model = buildHeaderTreeModel(
      graphOf([
        { rootFile: '/w/a.cpp', chain: ['/w/a.cpp', '/w/h.h'] },
        { rootFile: '/w/b.cpp', chain: ['/w/b.cpp', '/w/h.h'] },
        { rootFile: '/w/c.cpp', chain: ['/w/c.cpp', '/w/h.h'] },
      ]),
      '/w/h.h',
      ['/w/missing.cpp', '/w/c.cpp', '/w/a.cpp'],
    );
    expect(model.map((i) => i.rootFile)).toEqual(['/w/c.cpp', '/w/a.cpp', '/w/b.cpp']);
  });

  it('returns an empty model when the header has no chains', () => {
    expect(buildHeaderTreeModel(graphOf([]), '/w/h.h', ['/w/a.cpp'])).toEqual([]);
  });
});
