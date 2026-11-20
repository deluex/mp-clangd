import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  StateStore,
  buildHeaderTreeModel,
  buildIncludeGraph,
  chooseRoot,
  unitsForFile,
} from '@mp-clangd/core';
import type {
  HeaderRoot,
  HeaderTreeItem,
  IncludeGraph,
  Profile,
} from '@mp-clangd/core';
import { restartClangd } from './clangd.js';
import { isSourceFile, type NavigationTracker } from './navigation.js';
import type { StatusBar } from './status-bar.js';
import { materializeProfile } from './workspace.js';

export const HEADER_PATHS_VIEW_ID = 'mpClangd.headerPaths';
export const COMMAND_SHOW_HEADER_PATHS = 'mpClangd.showHeaderPaths';
export const COMMAND_SELECT_HEADER_ROOT = 'mpClangd.selectHeaderRoot';

export interface HeaderRootNode extends HeaderTreeItem {
  kind: 'root';
  selected: boolean;
}

export interface HeaderChainNode {
  kind: 'chain';
  rootFile: string;
  chain: string[];
}

export type HeaderTreeNode = HeaderRootNode | HeaderChainNode;

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  void vscode.window.showErrorMessage(`mp_clangd: ${message}`);
}

function activeFilePath(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  return editor === undefined ? undefined : path.resolve(editor.document.uri.fsPath);
}

function resolveUnitKey(
  profile: Profile,
  state: StateStore,
  rootFile: string,
): string | undefined {
  const units = unitsForFile(profile, rootFile);
  const selected = state.getUnitKey(profile.id, rootFile);
  return (units.find((unit) => unit.key === selected) ?? units[0])?.key;
}

class HeaderTreeProvider
  implements vscode.TreeDataProvider<HeaderTreeNode>, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<HeaderTreeNode | undefined>();
  private roots: HeaderTreeItem[] = [];
  private selectedRootFile: string | undefined;

  readonly onDidChangeTreeData = this.changed.event;

  setModel(roots: HeaderTreeItem[], selectedRootFile: string | undefined): void {
    this.roots = roots;
    this.selectedRootFile = selectedRootFile;
    this.changed.fire(undefined);
  }

  get currentRoots(): HeaderTreeItem[] {
    return this.roots;
  }

  getTreeItem(node: HeaderTreeNode): vscode.TreeItem {
    if (node.kind === 'root') {
      const item = new vscode.TreeItem(
        path.basename(node.rootFile),
        node.chains.length > 0
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.None,
      );
      item.description = node.selected ? 'selected' : path.dirname(node.rootFile);
      item.tooltip = node.rootFile;
      item.contextValue = 'mpClangdHeaderRoot';
      item.command = {
        command: COMMAND_SELECT_HEADER_ROOT,
        title: 'Select Header Root',
        arguments: [node],
      };
      return item;
    }

    const item = new vscode.TreeItem(
      node.chain.map((file) => path.basename(file)).join(' -> '),
    );
    item.tooltip = node.chain.join(' -> ');
    item.command = {
      command: COMMAND_SELECT_HEADER_ROOT,
      title: 'Select Header Root',
      arguments: [node],
    };
    return item;
  }

  getChildren(node?: HeaderTreeNode): HeaderTreeNode[] {
    if (node === undefined) {
      return this.roots.map((root) => ({
        kind: 'root',
        rootFile: root.rootFile,
        chains: root.chains,
        selected: root.rootFile === this.selectedRootFile,
      }));
    }
    if (node.kind === 'chain') {
      return [];
    }
    return node.chains.map((chain) => ({ kind: 'chain', rootFile: node.rootFile, chain }));
  }

  dispose(): void {
    this.changed.dispose();
  }
}

export interface HeaderTreeDependencies {
  workspaceDir: string | undefined;
  statusBar: StatusBar;
  navigation: NavigationTracker;
  profile?: Profile;
}

export class HeaderTree implements vscode.Disposable {
  private readonly provider = new HeaderTreeProvider();
  private readonly treeView: vscode.TreeView<HeaderTreeNode>;
  private readonly disposables: vscode.Disposable[] = [];
  private profile: Profile | undefined;
  private graph: IncludeGraph | undefined;
  private graphLoading: Promise<IncludeGraph | undefined> | undefined;
  private graphGeneration = 0;
  private currentHeader: string | undefined;

  constructor(private readonly deps: HeaderTreeDependencies) {
    this.profile = deps.profile;
    this.treeView = vscode.window.createTreeView(HEADER_PATHS_VIEW_ID, {
      treeDataProvider: this.provider,
    });
    this.disposables.push(
      this.treeView,
      this.provider,
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        void this.handleActiveEditor(editor);
      }),
      vscode.commands.registerCommand(COMMAND_SHOW_HEADER_PATHS, () => this.showHeaderPaths()),
      vscode.commands.registerCommand(COMMAND_SELECT_HEADER_ROOT, (node?: HeaderTreeNode) =>
        this.selectHeaderRoot(node),
      ),
    );
    void this.ensureGraph();
    void this.handleActiveEditor(vscode.window.activeTextEditor);
  }

  async setProfile(profile: Profile | undefined): Promise<void> {
    this.profile = profile;
    this.graphGeneration += 1;
    this.graph = undefined;
    this.graphLoading = undefined;
    this.provider.setModel([], undefined);
    void this.ensureGraph();
    await this.handleActiveEditor(vscode.window.activeTextEditor);
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  private async handleActiveEditor(editor: vscode.TextEditor | undefined): Promise<void> {
    try {
      if (editor === undefined) {
        this.showEmpty(undefined);
        return;
      }
      const file = path.resolve(editor.document.uri.fsPath);
      if (isSourceFile(file)) {
        this.showEmpty(undefined);
        this.updateStatusBar(file);
        return;
      }
      await this.showHeader(file);
    } catch (error) {
      showError(error);
    }
  }

  private async showHeader(header: string): Promise<void> {
    this.currentHeader = header;
    const profile = this.profile;
    const workspaceDir = this.deps.workspaceDir;
    if (profile === undefined || workspaceDir === undefined) {
      this.showEmpty(header);
      return;
    }

    const generation = this.graphGeneration;
    const graph = await this.ensureGraph();
    if (
      graph === undefined ||
      generation !== this.graphGeneration ||
      this.profile !== profile ||
      this.currentHeader !== header
    ) {
      return;
    }

    const roots = graph.rootsFor(header);
    if (roots.length === 0) {
      this.showEmpty(header);
      this.updateStatusBar(header);
      return;
    }

    const state = StateStore.load(workspaceDir);
    const history = state.getHeaderHistory(profile.id, header);
    const historyRoots = history.map((entry) => entry.rootFile);
    const selected = chooseRoot(roots, {
      originFile: this.deps.navigation.getOriginFile(header),
      history: historyRoots,
    });
    if (selected === undefined) {
      this.showEmpty(header);
      return;
    }

    const unitKey = resolveUnitKey(profile, state, selected.rootFile);
    if (unitKey === undefined) {
      this.showEmpty(header);
      return;
    }

    this.provider.setModel(
      buildHeaderTreeModel(graph, header, historyRoots),
      selected.rootFile,
    );
    this.applyRoot(profile, state, header, { rootFile: selected.rootFile, unitKey }, false);
    this.updateStatusBarFor(profile, state, selected.rootFile);
  }

  private async showHeaderPaths(): Promise<void> {
    try {
      const file = activeFilePath();
      if (file === undefined) {
        void vscode.window.showWarningMessage(
          'mp_clangd: open a C/C++ file to show header paths.',
        );
        return;
      }
      if (this.profile === undefined || this.deps.workspaceDir === undefined) {
        void vscode.window.showWarningMessage(
          'mp_clangd: no active profile; run "mp_clangd: Refresh" first.',
        );
        return;
      }

      await this.showHeader(file);
      if (this.provider.currentRoots.length === 0) {
        void vscode.window.showWarningMessage(
          `mp_clangd: no include chains for ${path.basename(file)} in the active profile.`,
        );
        return;
      }

      try {
        await vscode.commands.executeCommand(`${HEADER_PATHS_VIEW_ID}.focus`);
      } catch {
        // Focusing a view is best-effort and unavailable outside a contributed view.
      }
    } catch (error) {
      showError(error);
    }
  }

  private async selectHeaderRoot(node?: HeaderTreeNode): Promise<void> {
    try {
      const profile = this.profile;
      const workspaceDir = this.deps.workspaceDir;
      if (profile === undefined || workspaceDir === undefined) {
        void vscode.window.showWarningMessage(
          'mp_clangd: no active profile; run "mp_clangd: Refresh" first.',
        );
        return;
      }

      const header = this.currentHeader ?? activeFilePath();
      if (header === undefined) {
        void vscode.window.showWarningMessage(
          'mp_clangd: open a C/C++ file to select a header root.',
        );
        return;
      }

      let rootFile = node?.rootFile;
      if (rootFile === undefined) {
        await this.showHeader(header);
        if (this.provider.currentRoots.length === 0) {
          void vscode.window.showWarningMessage(
            `mp_clangd: no include chains for ${path.basename(header)} in the active profile.`,
          );
          return;
        }
        const picked = await vscode.window.showQuickPick(
          this.provider.currentRoots.map((root) => ({
            label: path.basename(root.rootFile),
            description: root.rootFile,
            rootFile: root.rootFile,
          })),
          { placeHolder: `Select a root for ${path.basename(header)}` },
        );
        if (picked === undefined) {
          return;
        }
        rootFile = picked.rootFile;
      }

      await this.applySelectedRoot(profile, header, rootFile, workspaceDir);
    } catch (error) {
      showError(error);
    }
  }

  private async applySelectedRoot(
    profile: Profile,
    header: string,
    rootFile: string,
    workspaceDir: string,
  ): Promise<void> {
    const state = StateStore.load(workspaceDir);
    const unitKey = resolveUnitKey(profile, state, rootFile);
    if (unitKey === undefined) {
      void vscode.window.showWarningMessage(
        `mp_clangd: no compile units for root ${path.basename(rootFile)}.`,
      );
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `mp_clangd: applying ${path.basename(rootFile)} for ${path.basename(header)}`,
      },
      async () => {
        this.applyRoot(profile, state, header, { rootFile, unitKey }, true);
      },
    );

    const saved = StateStore.load(workspaceDir);
    const graph = await this.ensureGraph();
    if (graph !== undefined && this.currentHeader === header) {
      const history = saved.getHeaderHistory(profile.id, header);
      this.provider.setModel(
        buildHeaderTreeModel(
          graph,
          header,
          history.map((entry) => entry.rootFile),
        ),
        rootFile,
      );
      this.updateStatusBarFor(profile, saved, rootFile);
    }

    await restartClangd();
    void vscode.window.showInformationMessage(
      `mp_clangd: header root for ${path.basename(header)}: ${path.basename(rootFile)}`,
    );
  }

  private applyRoot(
    profile: Profile,
    state: StateStore,
    header: string,
    root: HeaderRoot,
    recordHistory: boolean,
  ): void {
    const workspaceDir = this.deps.workspaceDir;
    if (workspaceDir === undefined) {
      return;
    }
    state.setHeaderRoot(profile.id, header, root);
    if (recordHistory) {
      state.pushHeaderHistory(profile.id, header, root);
    }
    state.save();
    materializeProfile(workspaceDir, state, profile);
  }

  private updateStatusBar(file: string): void {
    const profile = this.profile;
    const workspaceDir = this.deps.workspaceDir;
    if (profile === undefined || workspaceDir === undefined) {
      this.deps.statusBar.update(undefined);
      return;
    }
    this.updateStatusBarFor(profile, StateStore.load(workspaceDir), file);
  }

  private updateStatusBarFor(profile: Profile, state: StateStore, file: string): void {
    const units = unitsForFile(profile, file);
    if (units.length === 0) {
      this.deps.statusBar.update(profile.id);
      return;
    }
    const selected = state.getUnitKey(profile.id, file);
    const unit = units.find((candidate) => candidate.key === selected) ?? units[0];
    this.deps.statusBar.update(profile.id, units.length > 1 ? unit.label : undefined);
  }

  private showEmpty(header: string | undefined): void {
    this.currentHeader = header;
    this.provider.setModel([], undefined);
  }

  private async ensureGraph(): Promise<IncludeGraph | undefined> {
    const profile = this.profile;
    const workspaceDir = this.deps.workspaceDir;
    if (profile === undefined || workspaceDir === undefined) {
      return undefined;
    }
    if (this.graph !== undefined) {
      return this.graph;
    }
    if (this.graphLoading === undefined) {
      const generation = this.graphGeneration;
      this.graphLoading = buildIncludeGraph(profile.entries, { workspaceDir })
        .then((graph) => {
          if (generation === this.graphGeneration) {
            this.graph = graph;
          }
          return graph;
        })
        .catch((error: unknown) => {
          if (generation === this.graphGeneration) {
            this.graph = { rootsFor: () => [] };
            showError(error);
          }
          return undefined;
        })
        .finally(() => {
          if (generation === this.graphGeneration) {
            this.graphLoading = undefined;
          }
        });
    }
    return this.graphLoading;
  }
}
