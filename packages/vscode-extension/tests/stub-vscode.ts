/**
 * Minimal in-repo `vscode` module stub used by the extension tests.
 * `vitest.config.ts` aliases the `vscode` module to this file so the extension
 * sources can run headlessly in CI.
 */

export class Disposable {
  private readonly callback: () => void;

  constructor(callback: () => void = () => {}) {
    this.callback = callback;
  }

  dispose(): void {
    this.callback();
  }
}

export type Event<T> = (listener: (event: T) => unknown) => Disposable;

export class EventEmitter<T> {
  private listeners: Array<(event: T) => unknown> = [];

  readonly event: Event<T> = (listener) => {
    this.listeners.push(listener);
    return new Disposable(() => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) {
        this.listeners.splice(index, 1);
      }
    });
  };

  fire(event: T): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  dispose(): void {
    this.listeners = [];
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  label: string;
  collapsibleState: TreeItemCollapsibleState;
  description?: string;
  tooltip?: string;
  contextValue?: string;
  command?: { command: string; title: string; arguments?: unknown[] };

  constructor(label: string, collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

export interface StubUri {
  fsPath: string;
  scheme: string;
}

export const Uri = {
  file(fsPath: string): StubUri {
    return { fsPath, scheme: 'file' };
  },
};

export interface StubDocument {
  uri: StubUri;
}

export interface StubTextEditor {
  document: StubDocument;
}

export function textEditor(fsPath: string): StubTextEditor {
  return { document: { uri: Uri.file(fsPath) } };
}

export interface StubStatusBarItem {
  alignment: StatusBarAlignment;
  priority: number;
  name?: string;
  text: string;
  tooltip?: string;
  command?: string;
  visible: boolean;
  show(): void;
  hide(): void;
  dispose(): void;
}

export interface StubOutputChannel {
  name: string;
  lines: string[];
  visible: boolean;
  appendLine(line: string): void;
  append(text: string): void;
  show(preserveFocus?: boolean): void;
  hide(): void;
  clear(): void;
  dispose(): void;
}

export interface StubTreeView {
  id: string;
  options: {
    treeDataProvider?: {
      getChildren(node?: unknown): unknown[];
      getTreeItem(node: unknown): unknown;
    };
  };
  visible: boolean;
  dispose(): void;
}

export interface StubMessage {
  level: 'information' | 'warning' | 'error';
  message: string;
  items: string[];
}

export type QuickPickHandler = (items: readonly unknown[]) => unknown;

export interface Stub {
  workspaceFolders: Array<{ uri: StubUri }> | undefined;
  activeTextEditor: StubTextEditor | undefined;
  statusBarItems: StubStatusBarItem[];
  outputChannels: StubOutputChannel[];
  treeViews: StubTreeView[];
  messages: StubMessage[];
  informationChoices: string[];
  quickPick: QuickPickHandler;
  commandHandlers: Map<string, (...args: unknown[]) => unknown>;
  executedCommands: string[];
  setActiveEditor(editor: StubTextEditor | undefined): void;
  reset(): void;
}

const activeEditorEmitter = new EventEmitter<StubTextEditor | undefined>();

export const stub: Stub = {
  workspaceFolders: undefined,
  activeTextEditor: undefined,
  statusBarItems: [],
  outputChannels: [],
  treeViews: [],
  messages: [],
  informationChoices: [],
  quickPick: () => undefined,
  commandHandlers: new Map(),
  executedCommands: [],
  setActiveEditor(editor) {
    this.activeTextEditor = editor;
    activeEditorEmitter.fire(editor);
  },
  reset() {
    this.workspaceFolders = undefined;
    this.activeTextEditor = undefined;
    this.statusBarItems = [];
    this.outputChannels = [];
    this.treeViews = [];
    this.messages = [];
    this.informationChoices = [];
    this.quickPick = () => undefined;
    this.commandHandlers.clear();
    this.executedCommands = [];
    activeEditorEmitter.dispose();
  },
};

function createStatusBarItem(
  alignment: StatusBarAlignment,
  priority: number,
): StubStatusBarItem {
  const item: StubStatusBarItem = {
    alignment,
    priority,
    text: '',
    visible: false,
    show() {
      item.visible = true;
    },
    hide() {
      item.visible = false;
    },
    dispose() {
      item.visible = false;
    },
  };
  stub.statusBarItems.push(item);
  return item;
}

function createOutputChannel(name: string): StubOutputChannel {
  const channel: StubOutputChannel = {
    name,
    lines: [],
    visible: false,
    appendLine(line) {
      channel.lines.push(line);
    },
    append(text) {
      channel.lines.push(text);
    },
    show() {
      channel.visible = true;
    },
    hide() {
      channel.visible = false;
    },
    clear() {
      channel.lines = [];
    },
    dispose() {
      channel.visible = false;
    },
  };
  stub.outputChannels.push(channel);
  return channel;
}

function createTreeView(id: string, options: StubTreeView['options']): StubTreeView {
  const view: StubTreeView = {
    id,
    options,
    visible: true,
    dispose() {
      view.visible = false;
    },
  };
  stub.treeViews.push(view);
  return view;
}

export const window = {
  get activeTextEditor(): StubTextEditor | undefined {
    return stub.activeTextEditor;
  },
  createStatusBarItem,
  createOutputChannel,
  createTreeView,
  onDidChangeActiveTextEditor(listener: (editor: StubTextEditor | undefined) => unknown): Disposable {
    return activeEditorEmitter.event(listener);
  },
  showInformationMessage(message: string, ...items: string[]): Promise<string | undefined> {
    stub.messages.push({ level: 'information', message, items });
    return Promise.resolve(stub.informationChoices.shift());
  },
  showWarningMessage(message: string, ...items: string[]): Promise<string | undefined> {
    stub.messages.push({ level: 'warning', message, items });
    return Promise.resolve(undefined);
  },
  showErrorMessage(message: string, ...items: string[]): Promise<string | undefined> {
    stub.messages.push({ level: 'error', message, items });
    return Promise.resolve(undefined);
  },
  showQuickPick<T>(items: readonly T[]): Promise<T | undefined> {
    return Promise.resolve(stub.quickPick(items) as T | undefined);
  },
  withProgress<R>(
    _options: unknown,
    task: (
      progress: { report(value: { message?: string }): void },
      token: { isCancellationRequested: boolean; onCancellationRequested: Event<unknown> },
    ) => R | Promise<R>,
  ): Promise<R> {
    return Promise.resolve(
      task(
        { report: () => {} },
        { isCancellationRequested: false, onCancellationRequested: () => new Disposable() },
      ),
    );
  },
};

export const workspace = {
  get workspaceFolders(): Array<{ uri: StubUri }> | undefined {
    return stub.workspaceFolders;
  },
};

export const commands = {
  registerCommand(
    id: string,
    handler: (...args: unknown[]) => unknown,
  ): Disposable {
    stub.commandHandlers.set(id, handler);
    return new Disposable(() => {
      if (stub.commandHandlers.get(id) === handler) {
        stub.commandHandlers.delete(id);
      }
    });
  },
  executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
    stub.executedCommands.push(id);
    const handler = stub.commandHandlers.get(id);
    return Promise.resolve(handler === undefined ? undefined : handler(...args));
  },
};
