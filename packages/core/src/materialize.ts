import { join } from 'node:path';
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

function headerEntry(profile: Profile, request: HeaderRootRequest): CompileEntry | undefined {
  const root = unitsForFile(profile, request.rootFile).find(
    (unit) => unit.key === request.unitKey,
  );
  if (root === undefined) {
    return undefined;
  }
  const source = root.entry;
  let replaced = false;
  const args = source.arguments.map((argument) => {
    if (argument !== source.file) {
      return argument;
    }
    replaced = true;
    return request.header;
  });
  if (!replaced) {
    args.push(request.header);
  }
  return { directory: source.directory, file: request.header, arguments: args };
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
