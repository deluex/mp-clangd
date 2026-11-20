import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getWorkspaceDir } from './workspace.js';

export const CLANGD_ARGUMENT = '--compile-commands-dir=.mpclangd';

const CLANGD_RESTART_COMMAND = 'clangd.restart';

const SETTINGS_FILE = path.join('.vscode', 'settings.json');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

export function settingsContainClangdArgument(settingsText: string): boolean {
  try {
    const settings: unknown = JSON.parse(settingsText);
    if (!isRecord(settings)) {
      return false;
    }
    const args = settings['clangd.arguments'];
    return Array.isArray(args) && args.includes(CLANGD_ARGUMENT);
  } catch {
    // VS Code settings may contain comments, so fall back to a textual check.
    return settingsText.includes(CLANGD_ARGUMENT);
  }
}

export function hasClangdArgument(workspaceDir: string): boolean {
  const settingsText = readText(path.join(workspaceDir, SETTINGS_FILE));
  return settingsText !== undefined && settingsContainClangdArgument(settingsText);
}

export function settingsTextWithClangdArgument(settingsText: string | undefined): string {
  let settings: Record<string, unknown> = {};
  if (settingsText !== undefined && settingsText.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(settingsText);
    } catch {
      throw new Error('.vscode/settings.json is not valid JSON (comments are not supported)');
    }
    if (!isRecord(parsed)) {
      throw new Error('.vscode/settings.json must contain a JSON object');
    }
    settings = parsed;
  }

  const args = settings['clangd.arguments'];
  if (args === undefined) {
    settings['clangd.arguments'] = [CLANGD_ARGUMENT];
  } else if (Array.isArray(args)) {
    if (!args.includes(CLANGD_ARGUMENT)) {
      args.push(CLANGD_ARGUMENT);
    }
  } else {
    throw new Error('"clangd.arguments" in .vscode/settings.json is not an array');
  }

  return `${JSON.stringify(settings, null, 2)}\n`;
}

export async function ensureClangdArguments(): Promise<boolean> {
  const workspaceDir = getWorkspaceDir();
  if (workspaceDir === undefined) {
    return false;
  }

  const settingsPath = path.join(workspaceDir, SETTINGS_FILE);
  const settingsText = readText(settingsPath) ?? '';
  if (settingsContainClangdArgument(settingsText)) {
    return false;
  }

  const choice = await vscode.window.showInformationMessage(
    `mp_clangd: clangd.arguments does not contain "${CLANGD_ARGUMENT}". Add it to .vscode/settings.json?`,
    'Add',
    'Not Now',
  );
  if (choice !== 'Add') {
    return false;
  }

  let updated: string;
  try {
    updated = settingsTextWithClangdArgument(settingsText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showWarningMessage(
      `mp_clangd: cannot update .vscode/settings.json: ${message}. Add "${CLANGD_ARGUMENT}" to clangd.arguments manually.`,
    );
    return false;
  }

  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, updated, 'utf8');
  void vscode.window.showInformationMessage(
    `mp_clangd: added "${CLANGD_ARGUMENT}" to .vscode/settings.json.`,
  );
  return true;
}

export async function restartClangd(): Promise<void> {
  try {
    await vscode.commands.executeCommand(CLANGD_RESTART_COMMAND);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not found')) {
      void vscode.window.showWarningMessage(
        'mp_clangd: the clangd.restart command is unavailable; install or enable the clangd extension.',
      );
      return;
    }
    void vscode.window.showWarningMessage(`mp_clangd: clangd.restart failed: ${message}`);
  }
}
