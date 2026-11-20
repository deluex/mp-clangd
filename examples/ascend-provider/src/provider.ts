import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { atomicWriteJson } from '@mp-clangd/core';
import type { CompileEntry, Profile, ProfileSet } from '@mp-clangd/core';
import { matchesPreset, type Preset } from './preset.js';
import { buildClangdArgs, parseCc1, pickPasses, type ProbePass } from './probe.js';

// Ascend builds emit large cc1 command lines on stderr; the default 1 MiB
// buffer is not enough for real projects.
const PROBE_MAX_BUFFER = 64 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 120_000;

export type ProbeFn = (
  entry: CompileEntry,
  preset: Preset,
  cacheDir: string,
) => Promise<ProbePass[]>;

function cloneEntry(entry: CompileEntry): CompileEntry {
  const clone: CompileEntry = {
    directory: entry.directory,
    file: entry.file,
    arguments: [...entry.arguments],
  };
  if (entry.unverified !== undefined) {
    clone.unverified = entry.unverified;
  }
  return clone;
}

function oneLine(message: string): string {
  return message.replace(/\s+/g, ' ').trim();
}

function warnUnverified(entry: CompileEntry, reason: string): void {
  process.stderr.write(
    `mp_clangd ascend-provider: ${reason} for "${entry.file}"; emitting unverified entries\n`,
  );
}

/** Fallback passes: names only, so buildClangdArgs injects the preset macros. */
function fallbackPasses(preset: Preset): ProbePass[] {
  return preset.probe.passes.map((spec) => ({ name: spec.name, argv: [] }));
}

function probedEntry(
  entry: CompileEntry,
  pass: ProbePass,
  preset: Preset,
  verified: boolean,
): CompileEntry {
  const result: CompileEntry = {
    directory: entry.directory,
    file: entry.file,
    arguments: buildClangdArgs(entry, pass, preset),
  };
  if (!verified) {
    result.unverified = true;
  }
  return result;
}

/**
 * Expands every preset-matching entry into one profile per probe pass.
 * Profiles without matching entries are kept as they are. A probe or macro
 * verification failure only degrades that entry to unverified fallback
 * arguments; other entries and profiles are still emitted.
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
      let passes: ProbePass[];
      let verified: boolean;
      try {
        const probed = await probe(entry, preset, cacheDir);
        verified = probed.every((pass) => pass.verified === true);
        if (verified) {
          passes = probed;
        } else {
          warnUnverified(entry, 'probe verification failed');
          passes = fallbackPasses(preset);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnUnverified(entry, `probe failed (${oneLine(message)})`);
        verified = false;
        passes = fallbackPasses(preset);
      }

      for (const pass of passes) {
        let passEntries = entriesByPass.get(pass.name);
        if (passEntries === undefined) {
          passEntries = [];
          entriesByPass.set(pass.name, passEntries);
          passNames.push(pass.name);
        }
        passEntries.push(probedEntry(entry, pass, preset, verified));
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

function fileMtime(file: string): string {
  try {
    return String(statSync(file).mtimeMs);
  } catch {
    return 'missing';
  }
}

function compilerFile(entry: CompileEntry, compiler: string): string {
  if (path.isAbsolute(compiler)) {
    return compiler;
  }
  if (compiler.includes('/') || compiler.includes('\\')) {
    return path.resolve(entry.directory, compiler);
  }
  // Bare names are resolved through PATH so the cache key tracks the binary
  // that probe actually executes, including its mtime.
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (directory.length === 0) {
      continue;
    }
    const candidate = path.join(directory, compiler);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return path.resolve(entry.directory, compiler);
}

/**
 * Cache key: compiler path and mtime, entry directory and arguments, and the
 * source file mtime. A compiler upgrade, changed flags or an edited source
 * therefore invalidates the cached probe result.
 */
export function probeCacheKey(entry: CompileEntry, compiler: string): string {
  const compilerPath = compilerFile(entry, compiler);
  const sourcePath = path.resolve(entry.directory, entry.file);
  const key = [
    compilerPath,
    fileMtime(compilerPath),
    entry.directory,
    entry.arguments.join('\0'),
    fileMtime(sourcePath),
  ].join('\0');
  return createHash('sha1').update(key).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCachedPasses(raw: string): ProbePass[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.passes)) {
    return undefined;
  }
  const passes: ProbePass[] = [];
  for (const item of parsed.passes) {
    if (!isRecord(item)) {
      return undefined;
    }
    const { name, argv, output, arch, verified } = item;
    if (typeof name !== 'string') {
      return undefined;
    }
    const tokens = argv === undefined ? [] : argv;
    if (!Array.isArray(tokens)) {
      return undefined;
    }
    if (!tokens.every((token): token is string => typeof token === 'string')) {
      return undefined;
    }
    if (output !== undefined && typeof output !== 'string') {
      return undefined;
    }
    if (arch !== undefined && typeof arch !== 'string') {
      return undefined;
    }
    if (verified !== undefined && typeof verified !== 'boolean') {
      return undefined;
    }
    const pass: ProbePass = { name, argv: [...tokens] };
    if (output !== undefined) {
      pass.output = output;
    }
    if (arch !== undefined) {
      pass.arch = arch;
    }
    if (verified !== undefined) {
      pass.verified = verified;
    }
    passes.push(pass);
  }
  return passes;
}

function readProbeCache(cachePath: string): ProbePass[] | undefined {
  let raw: string;
  try {
    raw = readFileSync(cachePath, 'utf8');
  } catch {
    return undefined;
  }
  return parseCachedPasses(raw);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isMacroDefined(macros: string, macro: string): boolean {
  return new RegExp(`^#define\\s+${escapeRegExp(macro)}(?:\\s|$)`, 'm').test(macros);
}

/**
 * Re-runs a pass' cc1 command with `-dM -E` and checks every macro the preset
 * declares for that pass. `-o` is dropped so the macro dump goes to stdout.
 */
function verifyPass(entry: CompileEntry, pass: ProbePass, preset: Preset): boolean {
  const spec = preset.probe.passes.find((candidate) => candidate.name === pass.name);
  if (spec === undefined) {
    return false;
  }
  const argv = removeOutputArgs(pass.argv);
  argv.push('-dM', '-E');
  const [compiler, ...cc1Args] = argv;
  if (compiler === undefined) {
    return false;
  }
  const result = spawnSync(compiler, cc1Args, {
    cwd: entry.directory,
    encoding: 'utf8',
    maxBuffer: PROBE_MAX_BUFFER,
    timeout: PROBE_TIMEOUT_MS,
  });
  if (result.error !== undefined || result.status !== 0) {
    return false;
  }
  const macros = result.stdout ?? '';
  return spec.macros.every((macro) => isMacroDefined(macros, macro));
}

function verifyPasses(entry: CompileEntry, passes: ProbePass[], preset: Preset): ProbePass[] {
  return passes.map((pass) => ({ ...pass, verified: verifyPass(entry, pass, preset) }));
}

/**
 * Runs the compiler with `-v -c` and returns the passes declared by the preset.
 * Results are cached under `<cacheDir>/probe/<hash>.json`; on a hit the
 * compiler is not spawned. Each probe uses a unique temporary directory that
 * is removed recursively in `finally`, together with every device object.
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
  const cachePath = path.join(probeDir, `${probeCacheKey(entry, compiler)}.json`);
  const cached = readProbeCache(cachePath);
  if (cached !== undefined) {
    return cached;
  }

  const tempDir = path.join(probeDir, `run-${randomUUID()}`);
  mkdirSync(tempDir, { recursive: true });
  try {
    const tempOut = path.join(tempDir, 'probe.o');
    const driverArgs = removeOutputArgs(args);
    driverArgs.push('-v', '-c', '-o', tempOut);

    const result = spawnSync(compiler, driverArgs, {
      cwd: entry.directory,
      encoding: 'utf8',
      maxBuffer: PROBE_MAX_BUFFER,
      timeout: PROBE_TIMEOUT_MS,
    });
    if (result.error) {
      throw new Error(`failed to run probe command "${compiler}": ${result.error.message}`, {
        cause: result.error,
      });
    }

    const stderr = result.stderr ?? '';
    let passes: ProbePass[];
    try {
      passes = pickPasses(parseCc1(stderr), preset);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = result.status === null ? 'no exit status' : `exit code ${result.status}`;
      throw new Error(`probe of "${entry.file}" failed (${status}): ${message}`, {
        cause: error,
      });
    }

    const verified = verifyPasses(entry, passes, preset);
    // Only names and verification results are cached; argv/output would point
    // at the temporary directory that is deleted below.
    atomicWriteJson(cachePath, {
      passes: verified.map((pass) => ({ name: pass.name, verified: pass.verified })),
    });
    return verified;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
