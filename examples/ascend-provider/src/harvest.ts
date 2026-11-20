import * as path from 'node:path';
import { entryKey, type CompileEntry } from '@mp-clangd/core';
import { parse as parseShell } from 'shell-quote';

const CD_PREFIX = /^cd\s+(\S+)\s+&&\s+(.*)$/;
const COMPILER_NAMES = new Set(['bisheng', 'ccec']);
const SOURCE_SUFFIXES = ['.c', '.cc', '.cpp', '.cxx'];

function basename(value: string): string {
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1] ?? value;
}

function tokenAfter(tokens: string[], flag: string): string | undefined {
  const index = tokens.indexOf(flag);
  return index >= 0 ? tokens[index + 1] : undefined;
}

/**
 * Splits a command into plain tokens and stops at the first shell operator,
 * so pipelines and redirections (e.g. `2>&1 | tee build.log`) never leak
 * into the harvested arguments. The descriptor prefix of a redirection
 * (`2` in `2>&1`) is dropped, while glob tokens are skipped and parsing
 * continues so later arguments survive.
 */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  for (const entry of parseShell(command)) {
    if (typeof entry === 'string') {
      tokens.push(entry);
      continue;
    }
    if (!('op' in entry)) {
      continue;
    }
    if (entry.op === 'glob') {
      continue;
    }
    if (entry.op.startsWith('>') || entry.op.startsWith('<')) {
      const previous = tokens[tokens.length - 1];
      if (previous !== undefined && /^\d+$/.test(previous)) {
        tokens.pop();
      }
    }
    break;
  }
  return tokens;
}

function hasSourceSuffix(token: string): boolean {
  const lower = token.toLowerCase();
  return SOURCE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * Returns the first non-option token after `-c`, ignoring the output value of `-o`.
 */
function sourceAfterCompileFlag(tokens: string[], output: string | undefined): string | undefined {
  const index = tokens.indexOf('-c');
  if (index === -1) {
    return undefined;
  }
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor];
    if (token === output) {
      continue;
    }
    if (!token.startsWith('-')) {
      return token;
    }
  }
  return undefined;
}

function lastSourceToken(tokens: string[]): string | undefined {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (hasSourceSuffix(tokens[index])) {
      return tokens[index];
    }
  }
  return undefined;
}

function entryFromLine(line: string, fallback: string): CompileEntry | undefined {
  let directory = fallback;
  let command = line;
  const cdMatch = CD_PREFIX.exec(line);
  if (cdMatch !== null) {
    directory = path.resolve(fallback, cdMatch[1]);
    command = cdMatch[2];
  }

  const tokens = tokenize(command);
  const compiler = tokens[0];
  if (compiler === undefined || !COMPILER_NAMES.has(basename(compiler))) {
    return undefined;
  }

  const args = tokens.slice(1);
  if (!args.includes('-c') && !args.includes('-x')) {
    return undefined;
  }

  const output = tokenAfter(args, '-o');
  const source = sourceAfterCompileFlag(args, output) ?? lastSourceToken(args);
  if (source === undefined || source.length === 0) {
    return undefined;
  }

  return {
    directory,
    file: path.resolve(directory, source),
    arguments: tokens,
  };
}

/**
 * Extracts compile entries for bisheng/ccec invocations from a build log.
 * Recognized lines either start with the compiler or `cd <dir> && <compiler>`.
 * Malformed lines are skipped so one bad line cannot abort the harvest.
 */
export function harvestEntriesFromLog(log: string, defaultDirectory: string): CompileEntry[] {
  const fallback = path.resolve(defaultDirectory);
  const entries: CompileEntry[] = [];
  const seen = new Set<string>();

  for (const rawLine of log.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }

    try {
      const entry = entryFromLine(line, fallback);
      if (entry === undefined) {
        continue;
      }
      const key = entryKey(entry);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      entries.push(entry);
    } catch {
      // Build logs are arbitrary text; keep harvesting the remaining lines.
      continue;
    }
  }

  return entries;
}
