import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  StateStore,
  atomicWriteJson,
  loadConfig,
  materialize,
  parseProfileSet,
  registerProvider,
  runProviders,
  writeCompileCommands,
} from '@mp-clangd/core';
import type {
  HeaderRootRequest,
  Profile,
  ProfileSet,
} from '@mp-clangd/core';
import { createCdbProvider } from '@mp-clangd/provider-cdb';

export const MPCLANGD_DIRECTORY = '.mpclangd';
export const PROFILES_FILE = 'profiles.json';

export interface RefreshResult {
  profileSet: ProfileSet;
  cdbPath: string;
  profilesPath: string;
}

export function getWorkspaceDir(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function registerBuiltin(): void {
  registerProvider('builtin:cdb', createCdbProvider());
}

export function loadProfileSet(workspaceDir: string): Promise<ProfileSet> {
  return runProviders(workspaceDir, loadConfig(workspaceDir));
}

export interface ProviderStatus {
  use: string;
  ok: boolean;
  error?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function providerStatuses(workspaceDir: string): Promise<ProviderStatus[]> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(workspaceDir);
  } catch (error) {
    return [{ use: 'configuration', ok: false, error: errorMessage(error) }];
  }

  const statuses: ProviderStatus[] = [];
  for (const provider of config.providers) {
    try {
      await runProviders(workspaceDir, { providers: [provider] });
      statuses.push({ use: provider.use, ok: true });
    } catch (error) {
      statuses.push({ use: provider.use, ok: false, error: errorMessage(error) });
    }
  }
  return statuses;
}

export function profilesFilePath(workspaceDir: string): string {
  return path.join(workspaceDir, MPCLANGD_DIRECTORY, PROFILES_FILE);
}

export function readProfilesFile(workspaceDir: string): ProfileSet | undefined {
  let raw: string;
  try {
    raw = readFileSync(profilesFilePath(workspaceDir), 'utf8');
  } catch {
    return undefined;
  }
  try {
    return parseProfileSet(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function resolveActiveProfile(
  profileSet: ProfileSet,
  state: StateStore,
): Profile | undefined {
  const activeId = state.activeProfile;
  if (activeId !== undefined) {
    const active = profileSet.profiles.find((profile) => profile.id === activeId);
    if (active !== undefined) {
      return active;
    }
  }
  return profileSet.profiles[0];
}

export function headerRootsForProfile(
  state: StateStore,
  profileId: string,
): HeaderRootRequest[] {
  return state.listHeaderRoots(profileId).map(({ header, root }) => ({
    header,
    rootFile: root.rootFile,
    unitKey: root.unitKey,
  }));
}

export function materializeProfile(
  workspaceDir: string,
  state: StateStore,
  profile: Profile,
): string {
  const entries = materialize({
    profile,
    state,
    headerRoots: headerRootsForProfile(state, profile.id),
  });
  return writeCompileCommands(workspaceDir, entries);
}

export async function runRefresh(workspaceDir: string): Promise<RefreshResult> {
  const profileSet = await loadProfileSet(workspaceDir);
  const profilesPath = profilesFilePath(workspaceDir);
  atomicWriteJson(profilesPath, profileSet);

  const state = StateStore.load(workspaceDir);
  const profile = resolveActiveProfile(profileSet, state);
  if (profile === undefined) {
    throw new Error('no profiles found');
  }
  const cdbPath = materializeProfile(workspaceDir, state, profile);
  return { profileSet, cdbPath, profilesPath };
}
