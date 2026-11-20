import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { StateStore, entryKey } from '@mp-clangd/core';
import { activate, deactivate } from '../src/extension';
import { commands, stub, textEditor } from './stub-vscode';

interface TestContext {
  subscriptions: Array<{ dispose(): void }>;
}

let dir: string | undefined;
let context: TestContext | undefined;

function workspaceDir(): string {
  if (dir === undefined) {
    throw new Error('workspace is not initialized');
  }
  return dir;
}

function writeClangdSettings(): void {
  mkdirSync(join(workspaceDir(), '.vscode'), { recursive: true });
  writeFileSync(
    join(workspaceDir(), '.vscode', 'settings.json'),
    JSON.stringify({ 'clangd.arguments': ['--compile-commands-dir=.mpclangd'] }),
  );
}

function makeCdbWorkspace(): void {
  mkdirSync(join(workspaceDir(), 'build'), { recursive: true });
  writeFileSync(
    join(workspaceDir(), 'build', 'compile_commands.json'),
    JSON.stringify([{
      directory: join(workspaceDir(), 'build'),
      file: join(workspaceDir(), 'a.cpp'),
      arguments: ['clang++', '-c', join(workspaceDir(), 'a.cpp'), '-o', 'a.o'],
    }]),
  );
}

function activateExtension(): void {
  context = { subscriptions: [] };
  activate(context as unknown as vscode.ExtensionContext);
}

function treeProvider(): { getChildren(node?: unknown): unknown[] } {
  const view = stub.treeViews[0];
  if (view?.options.treeDataProvider === undefined) {
    throw new Error('header tree view was not created');
  }
  return view.options.treeDataProvider;
}

beforeEach(() => {
  stub.reset();
  dir = mkdtempSync(join(tmpdir(), 'mp-clangd-ext-'));
  stub.workspaceFolders = [{ uri: { fsPath: dir } }];
});

afterEach(() => {
  if (context !== undefined) {
    for (const disposable of context.subscriptions) {
      disposable.dispose();
    }
    context.subscriptions.length = 0;
    context = undefined;
  }
  deactivate();
  stub.reset();
  if (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe('activate', () => {
  it('registers the commands and creates the status bar', () => {
    writeClangdSettings();
    activateExtension();

    for (const command of [
      'mpClangd.selectProfile',
      'mpClangd.selectUnit',
      'mpClangd.refresh',
      'mpClangd.doctor',
      'mpClangd.showHeaderPaths',
      'mpClangd.selectHeaderRoot',
    ]) {
      expect(stub.commandHandlers.has(command)).toBe(true);
    }
    expect(stub.statusBarItems).toHaveLength(2);
    expect(stub.statusBarItems[0].text).toContain('mp_clangd');
    expect(stub.statusBarItems[0].visible).toBe(true);
    expect(stub.outputChannels.map((channel) => channel.name)).toContain('mp_clangd');
    expect(stub.treeViews.map((view) => view.id)).toContain('mpClangd.headerPaths');
  });
});

describe('selectProfile', () => {
  it('writes profiles.json atomically and applies the selection', async () => {
    writeClangdSettings();
    makeCdbWorkspace();
    stub.quickPick = (items) => items[0];
    activateExtension();

    await commands.executeCommand('mpClangd.selectProfile');

    const profilesPath = join(workspaceDir(), '.mpclangd', 'profiles.json');
    expect(existsSync(profilesPath)).toBe(true);
    const profiles = JSON.parse(readFileSync(profilesPath, 'utf8')) as {
      profiles: Array<{ id: string }>;
    };
    expect(profiles.profiles.map((profile) => profile.id)).toEqual(['build']);

    expect(
      readdirSync(join(workspaceDir(), '.mpclangd')).filter((name) => name.includes('.tmp-')),
    ).toEqual([]);

    const state = JSON.parse(
      readFileSync(join(workspaceDir(), '.mpclangd', 'state.json'), 'utf8'),
    ) as { activeProfile?: string };
    expect(state.activeProfile).toBe('build');
    expect(stub.statusBarItems[0].text).toContain('build');
    expect(existsSync(join(workspaceDir(), '.mpclangd', 'compile_commands.json'))).toBe(true);
  });
});

describe('selectUnit', () => {
  it('updates the state and repoints header roots', async () => {
    writeClangdSettings();
    const file = join(workspaceDir(), 'a.cpp');
    const header = join(workspaceDir(), 'a.h');
    const unitA = {
      directory: workspaceDir(),
      file,
      arguments: ['clang++', '-DA=1', '-c', file, '-o', 'a.o'],
    };
    const unitB = {
      directory: workspaceDir(),
      file,
      arguments: ['clang++', '-DB=1', '-c', file, '-o', 'b.o'],
    };
    mkdirSync(join(workspaceDir(), '.mpclangd'), { recursive: true });
    writeFileSync(
      join(workspaceDir(), '.mpclangd', 'profiles.json'),
      JSON.stringify({ profiles: [{ id: 'p', entries: [unitA, unitB] }] }),
    );
    const store = StateStore.load(workspaceDir());
    store.setActiveProfile('p');
    store.setUnitKey('p', file, entryKey(unitA));
    store.setHeaderRoot('p', header, { rootFile: file, unitKey: entryKey(unitA) });
    store.save();

    stub.activeTextEditor = textEditor(file);
    stub.quickPick = (items) => items[1];
    activateExtension();

    await commands.executeCommand('mpClangd.selectUnit');

    const reloaded = StateStore.load(workspaceDir());
    expect(reloaded.getUnitKey('p', file)).toBe(entryKey(unitB));
    expect(reloaded.getHeaderRoot('p', header)).toEqual({
      rootFile: file,
      unitKey: entryKey(unitB),
    });
    expect(stub.statusBarItems[1].text).toContain('B=1');

    const cdb = JSON.parse(
      readFileSync(join(workspaceDir(), '.mpclangd', 'compile_commands.json'), 'utf8'),
    ) as Array<{ file: string; arguments: string[] }>;
    const headerEntry = cdb.find((entry) => entry.file === header);
    expect(headerEntry?.arguments).toContain('-DB=1');
    expect(headerEntry?.arguments).not.toContain('-DA=1');
  });
});

describe('doctor', () => {
  it('reports provider status', async () => {
    writeClangdSettings();
    const failScript = join(workspaceDir(), 'fail-provider.mjs');
    writeFileSync(failScript, 'process.stderr.write("boom"); process.exit(3);');
    writeFileSync(
      join(workspaceDir(), 'mp_clangd.yaml'),
      [
        'providers:',
        '  - use: builtin:cdb',
        '  - use: command',
        '    command:',
        `      - ${JSON.stringify(process.execPath)}`,
        `      - ${JSON.stringify(failScript)}`,
      ].join('\n'),
    );

    activateExtension();
    await commands.executeCommand('mpClangd.doctor');

    const text = stub.outputChannels[0].lines.join('\n');
    expect(text).toContain('provider builtin:cdb: ok');
    expect(text).toContain('provider command: failed');
    expect(text).toContain('boom');
    expect(stub.outputChannels[0].visible).toBe(true);
  });
});

describe('header tree', () => {
  it('builds the model lazily and applies a selected root', async () => {
    writeClangdSettings();
    const main1 = join(workspaceDir(), 'main1.cpp');
    const main2 = join(workspaceDir(), 'main2.cpp');
    const header = join(workspaceDir(), 'h.h');
    writeFileSync(main1, '#include "h.h"\n');
    writeFileSync(main2, '#include "h.h"\n');
    writeFileSync(header, '#pragma once\n');

    const entries = [
      {
        directory: workspaceDir(),
        file: main1,
        arguments: ['clang++', '-DONE=1', '-c', main1, '-o', 'main1.o'],
      },
      {
        directory: workspaceDir(),
        file: main2,
        arguments: ['clang++', '-DTWO=1', '-c', main2, '-o', 'main2.o'],
      },
    ];
    mkdirSync(join(workspaceDir(), '.mpclangd'), { recursive: true });
    writeFileSync(
      join(workspaceDir(), '.mpclangd', 'profiles.json'),
      JSON.stringify({ profiles: [{ id: 'p', entries }] }),
    );

    activateExtension();
    expect(treeProvider().getChildren()).toEqual([]);

    stub.setActiveEditor(textEditor(header));
    await vi.waitFor(() => {
      expect(treeProvider().getChildren()).toHaveLength(2);
    });

    const roots = treeProvider().getChildren() as Array<{
      kind: string;
      rootFile: string;
      selected: boolean;
      chains: string[][];
    }>;
    expect(roots.map((root) => root.kind)).toEqual(['root', 'root']);
    expect(roots.map((root) => root.rootFile)).toEqual([main1, main2]);
    expect(roots[0].selected).toBe(true);
    expect(roots[0].chains[0]).toEqual([main1, header]);

    const main2Node = roots.find((root) => root.rootFile === main2);
    await commands.executeCommand('mpClangd.selectHeaderRoot', main2Node);

    const state = StateStore.load(workspaceDir());
    expect(state.getHeaderRoot('p', header)).toEqual({
      rootFile: main2,
      unitKey: entryKey(entries[1]),
    });
    expect(state.getHeaderHistory('p', header)[0]?.rootFile).toBe(main2);

    const cdb = JSON.parse(
      readFileSync(join(workspaceDir(), '.mpclangd', 'compile_commands.json'), 'utf8'),
    ) as Array<{ file: string; arguments: string[] }>;
    const headerEntry = cdb.find((entry) => entry.file === header);
    expect(headerEntry?.arguments).toContain('-DTWO=1');
    expect(headerEntry?.arguments).not.toContain('-DONE=1');
  });
});
