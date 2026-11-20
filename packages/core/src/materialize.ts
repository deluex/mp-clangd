import { join, resolve } from 'node:path';
import { normalizeEntry, unitsForFile, type Unit } from './entries.js';
import { atomicWriteJson } from './fs-utils.js';
import type { StateStore } from './state.js';
import type { CompileEntry, Profile } from './types.js';

export interface HeaderRootRequest {
  header: string;
  rootFile: string;
  unitKey: string;
}

export interface MaterializeInput {
  profile: Profile;
  state: StateStore;
  headerRoots: HeaderRootRequest[];
}

function compareFile(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function profileFiles(profile: Profile): string[] {
  const files = new Set<string>();
  for (const entry of profile.entries) {
    files.add(normalizeEntry(entry).file);
  }
  return [...files].sort(compareFile);
}

function selectUnit(profile: Profile, state: StateStore, file: string): Unit | undefined {
  const units = unitsForFile(profile, file);
  const key = state.getUnitKey(profile.id, file);
  return units.find((unit) => unit.key === key) ?? units[0];
}

function isSourceToken(source: CompileEntry, argument: string): boolean {
  if (argument.startsWith('-')) {
    return false;
  }
  return resolve(source.directory, argument) === source.file;
}

function replaceSourceToken(source: CompileEntry, header: string): string[] {
  const args = [...source.arguments];
  let index = args.indexOf(source.file);
  if (index === -1) {
    index = args.findIndex((argument) => isSourceToken(source, argument));
  }
  if (index === -1) {
    args.push(header);
  } else {
    args[index] = header;
  }
  return args;
}

function headerEntry(profile: Profile, request: HeaderRootRequest): CompileEntry | undefined {
  const root = unitsForFile(profile, request.rootFile).find(
    (unit) => unit.key === request.unitKey,
  );
  if (root === undefined) {
    return undefined;
  }
  const source = root.entry;
  const entry: CompileEntry = {
    directory: source.directory,
    file: request.header,
    arguments: replaceSourceToken(source, request.header),
  };
  if (source.unverified !== undefined) {
    entry.unverified = source.unverified;
  }
  return entry;
}

export function materialize(input: MaterializeInput): CompileEntry[] {
  const entries: CompileEntry[] = [];
  for (const file of profileFiles(input.profile)) {
    const unit = selectUnit(input.profile, input.state, file);
    if (unit !== undefined) {
      entries.push(unit.entry);
    }
  }
  for (const request of input.headerRoots) {
    const entry = headerEntry(input.profile, request);
    if (entry !== undefined) {
      entries.push(entry);
    }
  }
  return entries;
}

export function writeCompileCommands(workspaceDir: string, entries: CompileEntry[]): string {
  const file = join(workspaceDir, '.mpclangd', 'compile_commands.json');
  atomicWriteJson(file, entries);
  return file;
}
