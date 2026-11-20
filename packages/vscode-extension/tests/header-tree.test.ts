import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Profile } from '@mp-clangd/core';
import { HeaderTree } from '../src/header-tree';
import { NavigationTracker } from '../src/navigation';
import { StatusBar } from '../src/status-bar';
import { stub, textEditor } from './stub-vscode';

const ROOT_FILE = '/w/a.cpp';

let dir: string | undefined;
let tree: HeaderTree | undefined;
let statusBar: StatusBar | undefined;
let navigation: NavigationTracker | undefined;

const profile: Profile = {
  id: 'p',
  entries: [{
    directory: '/w',
    file: ROOT_FILE,
    arguments: ['clang++', '-c', ROOT_FILE, '-o', 'a.o'],
  }],
};

beforeEach(() => {
  stub.reset();
  dir = mkdtempSync(join(tmpdir(), 'mp-clangd-tree-'));
  stub.workspaceFolders = [{ uri: { fsPath: dir } }];
});

afterEach(() => {
  tree?.dispose();
  tree = undefined;
  statusBar?.dispose();
  statusBar = undefined;
  navigation?.dispose();
  navigation = undefined;
  stub.reset();
  if (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

function createTree(buildGraph: () => Promise<{ rootsFor(header: string): unknown[] }>): void {
  statusBar = new StatusBar();
  navigation = new NavigationTracker();
  tree = new HeaderTree({
    workspaceDir: dir,
    statusBar,
    navigation,
    profile,
    buildGraph: buildGraph as never,
  });
}

function treeProvider(): { getChildren(node?: unknown): unknown[] } {
  const view = stub.treeViews[0];
  if (view?.options.treeDataProvider === undefined) {
    throw new Error('header tree view was not created');
  }
  return view.options.treeDataProvider;
}

describe('HeaderTree include graph', () => {
  it('does not build the include graph during construction', () => {
    stub.activeTextEditor = textEditor(join(dir!, 'h.h'));
    const buildGraph = vi.fn(async () => ({ rootsFor: () => [] }));
    createTree(buildGraph);
    expect(buildGraph).not.toHaveBeenCalled();
  });

  it('retries after a failed graph build instead of caching the failure', async () => {
    const header = join(dir!, 'h.h');
    let fail = true;
    let calls = 0;
    const buildGraph = async () => {
      calls += 1;
      if (fail) {
        throw new Error('graph boom');
      }
      return {
        rootsFor: () => [{ rootFile: ROOT_FILE, chain: [ROOT_FILE, header] }],
      };
    };
    createTree(buildGraph);

    stub.setActiveEditor(textEditor(header));
    await vi.waitFor(() => expect(calls).toBe(1));
    await vi.waitFor(() => {
      expect(stub.messages.some((message) => message.message.includes('graph boom'))).toBe(true);
    });
    expect(treeProvider().getChildren()).toEqual([]);

    fail = false;
    stub.setActiveEditor(textEditor(header));
    await vi.waitFor(() => expect(calls).toBe(2));
    await vi.waitFor(() => {
      expect(treeProvider().getChildren()).toHaveLength(1);
    });
  });
});
