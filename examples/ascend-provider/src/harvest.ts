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

/**
 * Extracts compile entries for bisheng/ccec invocations from a build log.
 * Recognized lines either start with the compiler or `cd <dir> && <compiler>`.
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

    let directory = fallback;
    let command = line;
    const cdMatch = CD_PREFIX.exec(line);
    if (cdMatch !== null) {
      directory = path.resolve(fallback, cdMatch[1]);
      command = cdMatch[2];
    }

    const tokens = parseShell(command).filter(
      (token): token is string => typeof token === 'string',
    );
    const compiler = tokens[0];
    if (compiler === undefined || !COMPILER_NAMES.has(basename(compiler))) {
      continue;
    }

    const args = tokens.slice(1);
    if (!args.includes('-c') && !args.includes('-x')) {
      continue;
    }

    const output = tokenAfter(args, '-o');
    const source = sourceAfterCompileFlag(args, output) ?? lastSourceToken(args);
    if (source === undefined) {
      continue;
    }

    const entry: CompileEntry = {
      directory,
      file: path.resolve(directory, source),
      arguments: tokens,
    };
    const key = entryKey(entry);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    entries.push(entry);
  }

  return entries;
}
