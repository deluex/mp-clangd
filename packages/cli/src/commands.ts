import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  StateStore,
  atomicWriteJson,
  buildIncludeGraph,
  loadConfig,
  materialize,
  registerProvider,
  runProviders,
  unitsForFile,
  writeCompileCommands,
} from '@mp-clangd/core';
import type {
  HeaderRootRequest,
  Profile,
  ProfileSet,
  ProviderConfig,
} from '@mp-clangd/core';
import { createCdbProvider } from '@mp-clangd/provider-cdb';
import { USAGE, writeError, type CliIO } from './output.js';

const STATE_DIRECTORY = '.mpclangd';
const PROFILES_FILE = 'profiles.json';
const COMPILE_COMMANDS_FILE = 'compile_commands.json';
const CLANGD_ARGUMENT = '--compile-commands-dir=.mpclangd';

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

async function loadProfileSet(io: CliIO): Promise<ProfileSet> {
  return runProviders(io.cwd, loadConfig(io.cwd));
}

function findProfile(set: ProfileSet, id: string | undefined): Profile | undefined {
  if (id === undefined) {
    return undefined;
  }
  return set.profiles.find((profile) => profile.id === id);
}

function requireActiveProfile(set: ProfileSet, state: StateStore): Profile {
  const activeId = state.activeProfile ?? set.profiles[0]?.id;
  if (activeId === undefined) {
    throw new CliError('no profiles found');
  }
  const profile = findProfile(set, activeId);
  if (profile === undefined) {
    throw new CliError(`active profile "${activeId}" not found`);
  }
  return profile;
}

function headerRootsForProfile(state: StateStore, profileId: string): HeaderRootRequest[] {
  return state.listHeaderRoots(profileId).map(({ header, root }) => ({
    header,
    rootFile: root.rootFile,
    unitKey: root.unitKey,
  }));
}

function materializeProfile(io: CliIO, state: StateStore, profile: Profile): void {
  const entries = materialize({
    profile,
    state,
    headerRoots: headerRootsForProfile(state, profile.id),
  });
  const cdbPath = writeCompileCommands(io.cwd, entries);
  io.stdout(`wrote ${entries.length} entries to ${cdbPath}`);
}

function runInit(io: CliIO): number {
  const stateDir = path.join(io.cwd, STATE_DIRECTORY);
  mkdirSync(stateDir, { recursive: true });
  io.stdout(`created ${stateDir}`);

  const gitignorePath = path.join(io.cwd, '.gitignore');
  let content = '';
  try {
    content = readFileSync(gitignorePath, 'utf8');
  } catch {
    content = '';
  }
  const ignored = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .includes(`${STATE_DIRECTORY}/`);
  if (ignored) {
    io.stdout('.gitignore already contains .mpclangd/');
    return 0;
  }
  const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  writeFileSync(gitignorePath, `${content}${prefix}${STATE_DIRECTORY}/\n`, 'utf8');
  io.stdout('added .mpclangd/ to .gitignore');
  return 0;
}

async function runRefresh(io: CliIO): Promise<number> {
  const set = await loadProfileSet(io);
  const profilesPath = path.join(io.cwd, STATE_DIRECTORY, PROFILES_FILE);
  atomicWriteJson(profilesPath, set);
  io.stdout(`wrote ${set.profiles.length} profiles to ${profilesPath}`);

  const state = StateStore.load(io.cwd);
  const activeId = state.activeProfile ?? set.profiles[0]?.id;
  if (activeId === undefined) {
    throw new CliError('no profiles found');
  }
  const profile = findProfile(set, activeId);
  if (profile === undefined) {
    throw new CliError(`active profile "${activeId}" not found`);
  }

  materializeProfile(io, state, profile);
  io.stdout(`active profile: ${profile.id}`);
  return 0;
}

async function runProfiles(io: CliIO): Promise<number> {
  const set = await loadProfileSet(io);
  if (set.profiles.length === 0) {
    io.stdout('no profiles');
    return 0;
  }
  for (const profile of set.profiles) {
    io.stdout(`${profile.id} (${profile.entries.length} entries)`);
  }
  return 0;
}

async function runProfile(io: CliIO, args: string[]): Promise<number> {
  const name = args[0];
  if (name === undefined) {
    const state = StateStore.load(io.cwd);
    io.stdout(
      state.activeProfile === undefined
        ? 'no active profile'
        : `active profile: ${state.activeProfile}`,
    );
    return 0;
  }

  const set = await loadProfileSet(io);
  const profile = findProfile(set, name);
  if (profile === undefined) {
    throw new CliError(`profile "${name}" not found`);
  }
  const state = StateStore.load(io.cwd);
  state.setActiveProfile(profile.id);
  state.save();
  io.stdout(`active profile: ${profile.id}`);
  materializeProfile(io, state, profile);
  return 0;
}

async function runUnit(io: CliIO, args: string[]): Promise<number> {
  const [fileArg, name] = args;
  if (fileArg === undefined) {
    throw new CliError('usage: mp-clangd unit <file> [name]');
  }

  const set = await loadProfileSet(io);
  const state = StateStore.load(io.cwd);
  const profile = requireActiveProfile(set, state);
  const file = path.resolve(io.cwd, fileArg);
  const units = unitsForFile(profile, file);
  if (units.length === 0) {
    throw new CliError(`no compile units for "${file}"`);
  }

  if (name === undefined) {
    io.stdout(`units for ${file} (profile ${profile.id}):`);
    for (const unit of units) {
      io.stdout(`  ${unit.label} (${unit.key})`);
    }
    return 0;
  }

  const selected = units.find((unit) => unit.label === name || unit.key === name);
  if (selected === undefined) {
    throw new CliError(`unit "${name}" not found for "${file}"`);
  }
  state.setUnitKey(profile.id, file, selected.key);
  state.save();
  io.stdout(`unit for ${file}: ${selected.label}`);
  return 0;
}

async function runHeaders(io: CliIO, args: string[]): Promise<number> {
  const headerArg = args[0];
  if (headerArg === undefined) {
    throw new CliError('usage: mp-clangd headers <header>');
  }

  const set = await loadProfileSet(io);
  const state = StateStore.load(io.cwd);
  const profile = requireActiveProfile(set, state);
  const header = path.resolve(io.cwd, headerArg);
  const graph = await buildIncludeGraph(profile.entries, { workspaceDir: io.cwd });
  const roots = graph.rootsFor(header);
  if (roots.length === 0) {
    io.stdout(`no include chains for ${header}`);
    return 0;
  }
  for (const root of roots) {
    io.stdout(root.chain.join(' -> '));
  }
  return 0;
}

function hasClangdArgument(io: CliIO): boolean {
  const settingsPath = path.join(io.cwd, '.vscode', 'settings.json');
  let raw: string;
  try {
    raw = readFileSync(settingsPath, 'utf8');
  } catch {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return false;
    }
    const args = (parsed as Record<string, unknown>)['clangd.arguments'];
    return Array.isArray(args) && args.some((arg) => arg === CLANGD_ARGUMENT);
  } catch {
    // VS Code settings may contain comments, so fall back to a textual check.
    return raw.includes(CLANGD_ARGUMENT);
  }
}

function runDoctor(io: CliIO): number {
  const checks: Array<[string, boolean]> = [
    [
      `${STATE_DIRECTORY}/${PROFILES_FILE}`,
      existsSync(path.join(io.cwd, STATE_DIRECTORY, PROFILES_FILE)),
    ],
    [
      `${STATE_DIRECTORY}/${COMPILE_COMMANDS_FILE}`,
      existsSync(path.join(io.cwd, STATE_DIRECTORY, COMPILE_COMMANDS_FILE)),
    ],
    [
      `.vscode/settings.json contains ${CLANGD_ARGUMENT}`,
      hasClangdArgument(io),
    ],
  ];
  for (const [label, present] of checks) {
    io.stdout(`${present ? 'ok' : 'missing'} ${label}`);
  }
  return 0;
}

function describeProvider(provider: ProviderConfig): string {
  if (provider.use === 'builtin:cdb') {
    const parts = ['builtin:cdb'];
    if (provider.include !== undefined) {
      parts.push(`include=${JSON.stringify(provider.include)}`);
    }
    if (provider.exclude !== undefined) {
      parts.push(`exclude=${JSON.stringify(provider.exclude)}`);
    }
    return parts.join(' ');
  }

  const parts = [`command: ${provider.command.join(' ')}`];
  if (provider.config !== undefined) {
    parts.push(`config=${provider.config}`);
  }
  if (provider.output !== undefined) {
    parts.push(`output=${provider.output}`);
  }
  return parts.join(' ');
}

function runProvidersList(io: CliIO): number {
  const config = loadConfig(io.cwd);
  if (config.providers.length === 0) {
    io.stdout('no providers configured');
    return 0;
  }
  for (const provider of config.providers) {
    io.stdout(describeProvider(provider));
  }
  return 0;
}

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  registerProvider('builtin:cdb', createCdbProvider());

  const [command, ...args] = argv;
  try {
    switch (command) {
      case 'init':
        return runInit(io);
      case 'refresh':
        return await runRefresh(io);
      case 'profiles':
        return await runProfiles(io);
      case 'profile':
        return await runProfile(io, args);
      case 'unit':
        return await runUnit(io, args);
      case 'headers':
        return await runHeaders(io, args);
      case 'doctor':
        return runDoctor(io);
      case 'providers':
        return runProvidersList(io);
      default: {
        if (command !== undefined) {
          io.stderr(`error: unknown command "${command}"`);
        }
        io.stderr(USAGE);
        return 1;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return writeError(io, message);
  }
}
