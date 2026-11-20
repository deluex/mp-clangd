import * as path from 'node:path';
import type { CompileEntry, Profile, ProfileSet } from './types.js';

export class ProfileSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileSetError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseArguments(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProfileSetError(`${context}.arguments must be a non-empty array of strings`);
  }
  const args: string[] = [];
  for (const arg of value) {
    if (typeof arg !== 'string') {
      throw new ProfileSetError(`${context}.arguments must be a non-empty array of strings`);
    }
    args.push(arg);
  }
  return args;
}

function parseEntry(value: unknown, context: string): CompileEntry {
  if (!isRecord(value)) {
    throw new ProfileSetError(`${context} must be an object`);
  }
  const { directory, file, arguments: rawArguments, unverified } = value;
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw new ProfileSetError(`${context}.directory must be an absolute path`);
  }
  if (typeof file !== 'string' || file.length === 0) {
    throw new ProfileSetError(`${context}.file must be a non-empty string`);
  }
  if (unverified !== undefined && typeof unverified !== 'boolean') {
    throw new ProfileSetError(`${context}.unverified must be a boolean`);
  }
  const args = parseArguments(rawArguments, context);
  const entry: CompileEntry = {
    directory,
    file: path.resolve(directory, file),
    arguments: args,
  };
  if (unverified !== undefined) {
    entry.unverified = unverified;
  }
  return entry;
}

function parseProfile(value: unknown, context: string, seenIds: Set<string>): Profile {
  if (!isRecord(value)) {
    throw new ProfileSetError(`${context} must be an object`);
  }
  const { id, entries } = value;
  if (typeof id !== 'string' || id.length === 0) {
    throw new ProfileSetError(`${context}.id must be a non-empty string`);
  }
  if (seenIds.has(id)) {
    throw new ProfileSetError(`duplicate profile id "${id}"`);
  }
  seenIds.add(id);
  if (!Array.isArray(entries)) {
    throw new ProfileSetError(`${context}.entries must be an array`);
  }
  return {
    id,
    entries: entries.map((entry, index) => parseEntry(entry, `${context}.entries[${index}]`)),
  };
}

export function parseProfileSet(value: unknown): ProfileSet {
  if (!isRecord(value) || !Array.isArray(value.profiles)) {
    throw new ProfileSetError('profile set must be an object with a "profiles" array');
  }
  const seenIds = new Set<string>();
  return {
    profiles: value.profiles.map((profile, index) =>
      parseProfile(profile, `profiles[${index}]`, seenIds),
    ),
  };
}

function cloneProfile(profile: Profile): Profile {
  return {
    id: profile.id,
    entries: profile.entries.map((entry) => {
      const clone: CompileEntry = {
        directory: entry.directory,
        file: entry.file,
        arguments: [...entry.arguments],
      };
      if (entry.unverified !== undefined) {
        clone.unverified = entry.unverified;
      }
      return clone;
    }),
  };
}

export function mergeProfileSets(sets: ProfileSet[]): ProfileSet {
  const profiles: Profile[] = [];
  const seenIds = new Set<string>();
  for (const set of sets) {
    for (const profile of set.profiles) {
      if (seenIds.has(profile.id)) {
        throw new ProfileSetError(`duplicate profile id "${profile.id}"`);
      }
      seenIds.add(profile.id);
      profiles.push(cloneProfile(profile));
    }
  }
  return { profiles };
}
