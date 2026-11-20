import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { atomicWriteJson } from './fs-utils.js';

export interface HeaderRoot {
  rootFile: string;
  unitKey: string;
}

interface StateFile {
  activeProfile?: string;
  fileUnits: Record<string, string>;
  headerRoots: Record<string, HeaderRoot>;
  headerHistory: Record<string, HeaderRoot[]>;
}

const STATE_DIRECTORY = '.mpclangd';
const STATE_FILE = 'state.json';
const MAX_HISTORY = 20;

function emptyState(): StateFile {
  return { fileUnits: {}, headerRoots: {}, headerHistory: {} };
}

function compositeKey(profileId: string, file: string): string {
  return `${profileId}\u0000${file}`;
}

function cloneRoot(root: HeaderRoot): HeaderRoot {
  return { rootFile: root.rootFile, unitKey: root.unitKey };
}

function sameRoot(left: HeaderRoot, right: HeaderRoot): boolean {
  return left.rootFile === right.rootFile && left.unitKey === right.unitKey;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseHeaderRoot(value: unknown): HeaderRoot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { rootFile, unitKey } = value;
  if (typeof rootFile !== 'string' || typeof unitKey !== 'string') {
    return undefined;
  }
  return { rootFile, unitKey };
}

function parseStringRecord(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!isRecord(value)) {
    return result;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      result[key] = entry;
    }
  }
  return result;
}

function parseHeaderRootRecord(value: unknown): Record<string, HeaderRoot> {
  const result: Record<string, HeaderRoot> = {};
  if (!isRecord(value)) {
    return result;
  }
  for (const [key, entry] of Object.entries(value)) {
    const root = parseHeaderRoot(entry);
    if (root !== undefined) {
      result[key] = root;
    }
  }
  return result;
}

function parseHeaderHistoryRecord(value: unknown): Record<string, HeaderRoot[]> {
  const result: Record<string, HeaderRoot[]> = {};
  if (!isRecord(value)) {
    return result;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!Array.isArray(entry)) {
      continue;
    }
    const history: HeaderRoot[] = [];
    for (const item of entry) {
      const root = parseHeaderRoot(item);
      if (root !== undefined) {
        history.push(root);
      }
    }
    result[key] = history.slice(0, MAX_HISTORY);
  }
  return result;
}

function parseState(raw: string): StateFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyState();
  }
  if (!isRecord(parsed)) {
    return emptyState();
  }
  return {
    activeProfile: typeof parsed.activeProfile === 'string' ? parsed.activeProfile : undefined,
    fileUnits: parseStringRecord(parsed.fileUnits),
    headerRoots: parseHeaderRootRecord(parsed.headerRoots),
    headerHistory: parseHeaderHistoryRecord(parsed.headerHistory),
  };
}

export class StateStore {
  readonly path: string;
  private state: StateFile;

  private constructor(statePath: string, state: StateFile) {
    this.path = statePath;
    this.state = state;
  }

  static load(workspaceDir: string): StateStore {
    const statePath = path.join(workspaceDir, STATE_DIRECTORY, STATE_FILE);
    let raw: string;
    try {
      raw = readFileSync(statePath, 'utf8');
    } catch {
      return new StateStore(statePath, emptyState());
    }
    return new StateStore(statePath, parseState(raw));
  }

  get activeProfile(): string | undefined {
    return this.state.activeProfile;
  }

  setActiveProfile(id: string): void {
    this.state.activeProfile = id;
  }

  getUnitKey(profileId: string, file: string): string | undefined {
    return this.state.fileUnits[compositeKey(profileId, file)];
  }

  setUnitKey(profileId: string, file: string, unitKey: string): void {
    this.state.fileUnits[compositeKey(profileId, file)] = unitKey;
  }

  getHeaderRoot(profileId: string, header: string): HeaderRoot | undefined {
    const root = this.state.headerRoots[compositeKey(profileId, header)];
    return root === undefined ? undefined : cloneRoot(root);
  }

  setHeaderRoot(profileId: string, header: string, root: HeaderRoot): void {
    this.state.headerRoots[compositeKey(profileId, header)] = cloneRoot(root);
  }

  getHeaderHistory(profileId: string, header: string): HeaderRoot[] {
    const history = this.state.headerHistory[compositeKey(profileId, header)];
    return history === undefined ? [] : history.map(cloneRoot);
  }

  pushHeaderHistory(profileId: string, header: string, root: HeaderRoot): void {
    const key = compositeKey(profileId, header);
    const entry = cloneRoot(root);
    const history = (this.state.headerHistory[key] ?? []).filter(
      (candidate) => !sameRoot(candidate, entry),
    );
    history.unshift(entry);
    this.state.headerHistory[key] = history.slice(0, MAX_HISTORY);
  }

  save(): void {
    atomicWriteJson(this.path, this.state);
  }
}
