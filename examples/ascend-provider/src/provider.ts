import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import type { CompileEntry, Profile, ProfileSet } from '@mp-clangd/core';
import { matchesPreset, type Preset } from './preset.js';
import { buildClangdArgs, parseCc1, pickPasses, type ProbePass } from './probe.js';

export type ProbeFn = (
  entry: CompileEntry,
  preset: Preset,
  cacheDir: string,
) => Promise<ProbePass[]>;

function cloneEntry(entry: CompileEntry): CompileEntry {
  return {
    directory: entry.directory,
    file: entry.file,
    arguments: [...entry.arguments],
  };
}

/**
 * Expands every preset-matching entry into one profile per probe pass.
 * Profiles without matching entries are kept as they are.
 */
export async function buildAscendProfileSet(
  base: ProfileSet,
  preset: Preset,
  probe: ProbeFn,
  cacheDir: string,
): Promise<ProfileSet> {
  const profiles: Profile[] = [];

  for (const profile of base.profiles) {
    const matching: CompileEntry[] = [];
    const others: CompileEntry[] = [];
    for (const entry of profile.entries) {
      if (matchesPreset(entry, preset)) {
        matching.push(entry);
      } else {
        others.push(entry);
      }
    }

    if (matching.length === 0) {
      profiles.push({ id: profile.id, entries: profile.entries.map(cloneEntry) });
      continue;
    }

    const passNames: string[] = [];
    const entriesByPass = new Map<string, CompileEntry[]>();
    for (const entry of matching) {
      const passes = await probe(entry, preset, cacheDir);
      for (const pass of passes) {
        let passEntries = entriesByPass.get(pass.name);
        if (passEntries === undefined) {
          passEntries = [];
          entriesByPass.set(pass.name, passEntries);
          passNames.push(pass.name);
        }
        passEntries.push({
          directory: entry.directory,
          file: entry.file,
          arguments: buildClangdArgs(entry, pass, preset),
        });
      }
    }

    for (const name of passNames) {
      profiles.push({
        id: `${profile.id}/${name}`,
        entries: [...others.map(cloneEntry), ...(entriesByPass.get(name) ?? [])],
      });
    }
  }

  return { profiles };
}

function removeOutputArgs(args: string[]): string[] {
  const result = [...args];
  for (let index = 0; index < result.length; index += 1) {
    if (result[index] === '-o') {
      result.splice(index, result[index + 1] === undefined ? 1 : 2);
      index -= 1;
    }
  }
  return result;
}

/**
 * Runs the compiler with `-v -c` and returns the passes declared by the preset.
 */
export async function probeEntry(
  entry: CompileEntry,
  preset: Preset,
  cacheDir: string,
): Promise<ProbePass[]> {
  const args = [...entry.arguments];
  const compiler = args.shift();
  if (compiler === undefined) {
    throw new Error(`cannot probe "${entry.file}": entry has no compiler argument`);
  }

  const probeDir = path.join(cacheDir, 'probe');
  mkdirSync(probeDir, { recursive: true });
  const tempOut = path.join(probeDir, `probe-${randomUUID()}.o`);
  const driverArgs = removeOutputArgs(args);
  driverArgs.push('-v', '-c', '-o', tempOut);

  const result = spawnSync(compiler, driverArgs, {
    cwd: entry.directory,
    encoding: 'utf8',
  });
  if (result.error) {
    throw new Error(`failed to run probe command "${compiler}": ${result.error.message}`, {
      cause: result.error,
    });
  }

  const stderr = result.stderr ?? '';
  try {
    return pickPasses(parseCc1(stderr), preset);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = result.status === null ? 'no exit status' : `exit code ${result.status}`;
    throw new Error(`probe of "${entry.file}" failed (${status}): ${message}`, {
      cause: error,
    });
  }
}
