import * as path from 'node:path';
import * as vscode from 'vscode';

const SOURCE_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cxx', '.c++']);

export function isSourceFile(file: string): boolean {
  return SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

export class NavigationTracker implements vscode.Disposable {
  private readonly listener: vscode.Disposable;
  private lastSource: string | undefined;

  constructor() {
    this.listener = vscode.window.onDidChangeActiveTextEditor((editor) => {
      this.record(editor);
    });
    this.record(vscode.window.activeTextEditor);
  }

  private record(editor: vscode.TextEditor | undefined): void {
    const file = editor?.document.uri.fsPath;
    if (file !== undefined && isSourceFile(file)) {
      this.lastSource = path.resolve(file);
    }
  }

  getOriginFile(header: string): string | undefined {
    const origin = this.lastSource;
    if (origin === undefined || origin === path.resolve(header)) {
      return undefined;
    }
    return origin;
  }

  dispose(): void {
    this.listener.dispose();
  }
}
