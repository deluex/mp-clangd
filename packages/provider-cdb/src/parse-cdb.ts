import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { CompileEntry } from '@mp-clangd/core';
import { parse as parseShellCommand } from 'shell-quote';

interface RawCdbEntry {
  directory?: unknown;
  file?: unknown;
  arguments?: unknown;
  command?: unknown;
}

function entryArguments(raw: RawCdbEntry, cdbPath: string, index: number): string[] {
  if (Array.isArray(raw.arguments)) {
    if (raw.arguments.length === 0 || raw.arguments.some((token) => typeof token !== 'string')) {
      throw new Error(`${cdbPath}: entry ${index} has invalid "arguments"`);
    }
    return [...raw.arguments] as string[];
  }
  if (typeof raw.command === 'string') {
    return parseShellCommand(raw.command).filter(
      (token): token is string => typeof token === 'string',
    );
  }
  throw new Error(`${cdbPath}: entry ${index} must have "arguments" or "command"`);
}

function entryDirectory(raw: RawCdbEntry, cdbPath: string, index: number): string {
  if (typeof raw.directory !== 'string' || raw.directory.length === 0) {
    throw new Error(`${cdbPath}: entry ${index} must have a "directory"`);
  }
  if (path.isAbsolute(raw.directory)) {
    return path.normalize(raw.directory);
  }
  return path.resolve(path.dirname(path.resolve(cdbPath)), raw.directory);
}

function readCdb(cdbPath: string): unknown {
  let text: string;
  try {
    text = readFileSync(cdbPath, 'utf8');
  } catch (error) {
    throw new Error(`${cdbPath}: failed to read compile commands database`, { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${cdbPath}: invalid JSON`, { cause: error });
  }
}

export function parseCdbFile(cdbPath: string): CompileEntry[] {
  const raw = readCdb(cdbPath);
  if (!Array.isArray(raw)) {
    throw new Error(`${cdbPath}: compile commands database must be a JSON array`);
  }
  return raw.map((value: unknown, index: number) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${cdbPath}: entry ${index} must be an object`);
    }
    const entry = value as RawCdbEntry;
    if (typeof entry.file !== 'string' || entry.file.length === 0) {
      throw new Error(`${cdbPath}: entry ${index} must have a "file"`);
    }
    const directory = entryDirectory(entry, cdbPath, index);
    return {
      directory,
      file: path.resolve(directory, entry.file),
      arguments: entryArguments(entry, cdbPath, index),
    };
  });
}
