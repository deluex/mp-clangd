import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  StateStore,
  atomicWriteJson,
  unitsForFile,
  updateHeaderRootsForFile,
} from '@mp-clangd/core';
import type { Profile, ProfileSet } from '@mp-clangd/core';
import {
  CLANGD_ARGUMENT,
  ensureClangdArguments,
  hasClangdArgument,
  restartClangd,
} from './clangd.js';
import { HeaderTree } from './header-tree.js';
import { NavigationTracker } from './navigation.js';
import { StatusBar } from './status-bar.js';
import {
  MPCLANGD_DIRECTORY,
  PROFILES_FILE,
  getWorkspaceDir,
  loadProfileSet,
  materializeProfile,
  profilesFilePath,
  providerStatuses,
  readProfilesFile,
  registerBuiltin,
  resolveActiveProfile,
  runRefresh,
} from './workspace.js';

const COMMAND_SELECT_PROFILE = 'mpClangd.selectProfile';
const COMMAND_SELECT_UNIT = 'mpClangd.selectUnit';
const COMMAND_REFRESH = 'mpClangd.refresh';
const COMMAND_DOCTOR = 'mpClangd.doctor';
const OUTPUT_CHANNEL_NAME = 'mp_clangd';
const COMPILE_COMMANDS_FILE = 'compile_commands.json';

let statusBar: StatusBar | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let profileSetCache: ProfileSet | undefined;
let headerTree: HeaderTree | undefined;

function requireWorkspaceDir(): string | undefined {
  const workspaceDir = getWorkspaceDir();
  if (workspaceDir === undefined) {
    void vscode.window.showErrorMessage('mp_clangd: open a workspace folder first.');
  }
  return workspaceDir;
}

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  void vscode.window.showErrorMessage(`mp_clangd: ${message}`);
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

async function profileSetFor(workspaceDir: string): Promise<ProfileSet> {
  if (profileSetCache !== undefined) {
    return profileSetCache;
  }
  const fromDisk = readProfilesFile(workspaceDir);
  profileSetCache = fromDisk ?? (await loadProfileSet(workspaceDir));
  return profileSetCache;
}

async function selectProfile(): Promise<void> {
  const workspaceDir = requireWorkspaceDir();
  if (workspaceDir === undefined) {
    return;
  }

  try {
    const profileSet = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'mp_clangd: collecting profiles' },
      () => loadProfileSet(workspaceDir),
    );
    profileSetCache = profileSet;
    atomicWriteJson(profilesFilePath(workspaceDir), profileSet);

    if (profileSet.profiles.length === 0) {
      void vscode.window.showWarningMessage('mp_clangd: no profiles found.');
      return;
    }

    const picked = await vscode.window.showQuickPick(
      profileSet.profiles.map((profile) => ({
        label: profile.id,
        description: countLabel(profile.entries.length, 'entry'),
        profile,
      })),
      { placeHolder: 'Select an mp_clangd profile' },
    );
    if (picked === undefined) {
      return;
    }

    const state = StateStore.load(workspaceDir);
    state.setActiveProfile(picked.profile.id);
    state.save();
    materializeProfile(workspaceDir, state, picked.profile);
    statusBar?.update(picked.profile.id);
    await headerTree?.setProfile(picked.profile);

    await ensureClangdArguments();
    await restartClangd();
    void vscode.window.showInformationMessage(`mp_clangd: active profile ${picked.profile.id}`);
  } catch (error) {
    showError(error);
  }
}

async function selectUnit(): Promise<void> {
  const workspaceDir = requireWorkspaceDir();
  if (workspaceDir === undefined) {
    return;
  }

  const editor = vscode.window.activeTextEditor;
  const file = editor === undefined ? undefined : path.resolve(editor.document.uri.fsPath);
  if (file === undefined) {
    void vscode.window.showWarningMessage('mp_clangd: open a C/C++ file to select a compile unit.');
    return;
  }

  try {
    const profileSet = await profileSetFor(workspaceDir);
    const state = StateStore.load(workspaceDir);
    const profile = resolveActiveProfile(profileSet, state);
    if (profile === undefined) {
      void vscode.window.showWarningMessage(
        'mp_clangd: no profiles found; run "mp_clangd: Refresh" first.',
      );
      return;
    }

    const units = unitsForFile(profile, file);
    if (units.length === 0) {
      void vscode.window.showWarningMessage(
        `mp_clangd: no compile units for ${path.basename(file)} in profile "${profile.id}".`,
      );
      return;
    }

    const picked = await vscode.window.showQuickPick(
      units.map((unit) => ({
        label: unit.label,
        description: unit.key.slice(0, 8),
        unit,
      })),
      { placeHolder: `Select a compile unit for ${path.basename(file)}` },
    );
    if (picked === undefined) {
      return;
    }

    state.setUnitKey(profile.id, file, picked.unit.key);
    // A root file's unit change applies to every header that uses it as a root.
    updateHeaderRootsForFile(state, profile.id, file, picked.unit.key);
    state.save();
    materializeProfile(workspaceDir, state, profile);
    statusBar?.update(profile.id, units.length > 1 ? picked.unit.label : undefined);
    await restartClangd();
    void vscode.window.showInformationMessage(
      `mp_clangd: compile unit for ${path.basename(file)}: ${picked.unit.label}`,
    );
  } catch (error) {
    showError(error);
  }
}

async function refresh(): Promise<void> {
  const workspaceDir = requireWorkspaceDir();
  if (workspaceDir === undefined) {
    return;
  }

  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'mp_clangd: refreshing profiles' },
      () => runRefresh(workspaceDir),
    );
    profileSetCache = result.profileSet;

    const state = StateStore.load(workspaceDir);
    const profile = resolveActiveProfile(result.profileSet, state);
    statusBar?.update(profile?.id);
    await headerTree?.setProfile(profile);
    void vscode.window.showInformationMessage(
      `mp_clangd: refreshed ${countLabel(result.profileSet.profiles.length, 'profile')} and wrote ${result.cdbPath}`,
    );
  } catch (error) {
    showError(error);
  }
}

function checkLabel(present: boolean): string {
  return present ? 'ok' : 'missing';
}

async function doctor(): Promise<void> {
  const workspaceDir = requireWorkspaceDir();
  if (workspaceDir === undefined || outputChannel === undefined) {
    return;
  }

  const state = StateStore.load(workspaceDir);
  const profileSet = readProfilesFile(workspaceDir);
  const profile = profileSet === undefined ? undefined : resolveActiveProfile(profileSet, state);
  const profileId = profile?.id ?? state.activeProfile;
  const cdbPath = path.join(workspaceDir, MPCLANGD_DIRECTORY, COMPILE_COMMANDS_FILE);
  const profileCount = profileSet?.profiles.length;
  const profileSuffix = profileCount === undefined
    ? ''
    : ` (${countLabel(profileCount, 'profile')})`;

  outputChannel.appendLine('mp_clangd doctor');
  outputChannel.appendLine(`workspace: ${workspaceDir}`);
  outputChannel.appendLine(
    `${checkLabel(existsSync(profilesFilePath(workspaceDir)))} ${MPCLANGD_DIRECTORY}/${PROFILES_FILE}`,
  );
  outputChannel.appendLine(
    `${checkLabel(existsSync(cdbPath))} ${MPCLANGD_DIRECTORY}/${COMPILE_COMMANDS_FILE}`,
  );
  outputChannel.appendLine(
    `${checkLabel(profileId !== undefined)} profile: ${profileId ?? 'none'}${profileSuffix}`,
  );
  outputChannel.appendLine(
    `${checkLabel(hasClangdArgument(workspaceDir))} clangd.arguments contains ${CLANGD_ARGUMENT}`,
  );
  for (const status of await providerStatuses(workspaceDir)) {
    const detail = status.ok
      ? 'ok'
      : `failed - ${(status.error ?? 'unknown error').replace(/\s+/g, ' ').trim()}`;
    outputChannel.appendLine(`provider ${status.use}: ${detail}`);
  }
  outputChannel.show(true);
}

export function activate(context: vscode.ExtensionContext): void {
  registerBuiltin();

  statusBar = new StatusBar();
  context.subscriptions.push(statusBar);

  outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(outputChannel);

  const workspaceDir = getWorkspaceDir();
  let profile: Profile | undefined;
  if (workspaceDir === undefined) {
    statusBar.update(undefined);
  } else {
    const state = StateStore.load(workspaceDir);
    const profileSet = readProfilesFile(workspaceDir);
    profile = profileSet === undefined ? undefined : resolveActiveProfile(profileSet, state);
    statusBar.update(profile?.id ?? state.activeProfile);
  }

  const navigation = new NavigationTracker();
  headerTree = new HeaderTree({
    workspaceDir,
    statusBar,
    navigation,
    profile,
  });
  context.subscriptions.push(headerTree, navigation);

  void ensureClangdArguments();

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_SELECT_PROFILE, () => selectProfile()),
    vscode.commands.registerCommand(COMMAND_SELECT_UNIT, () => selectUnit()),
    vscode.commands.registerCommand(COMMAND_REFRESH, () => refresh()),
    vscode.commands.registerCommand(COMMAND_DOCTOR, () => doctor()),
  );
}

export function deactivate(): void {
  profileSetCache = undefined;
  headerTree = undefined;
  statusBar?.dispose();
  statusBar = undefined;
  outputChannel?.dispose();
  outputChannel = undefined;
}
