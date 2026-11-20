import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { CompileEntry, Profile } from './types.js';

export interface Unit {
  key: string;
  entry: CompileEntry;
  label: string;
}

export function normalizeEntry(entry: CompileEntry): CompileEntry {
  return { ...entry, file: path.resolve(entry.directory, entry.file) };
}

export function entryKey(entry: CompileEntry): string {
  return createHash('sha1')
    .update(entry.directory + '\0' + entry.arguments.join('\0'))
    .digest('hex');
}

function outputBasename(entry: CompileEntry): string | undefined {
  const index = entry.arguments.indexOf('-o');
  if (index === -1 || index + 1 >= entry.arguments.length) {
    return undefined;
  }
  return path.basename(entry.arguments[index + 1]);
}

function differingDefine(entry: CompileEntry, others: CompileEntry[]): string | undefined {
  const otherTokenSets = others.map((other) => new Set(other.arguments));
  const candidates = entry.arguments
    .filter((argument) => argument.startsWith('-D'))
    .filter(
      (argument) =>
        otherTokenSets.length === 0 ||
        !otherTokenSets.every((tokens) => tokens.has(argument)),
    )
    .sort();
  const candidate = candidates[0];
  return candidate === undefined ? undefined : candidate.slice(2);
}

export function deriveUnitLabel(entries: CompileEntry[], entry: CompileEntry): string {
  const others = entries.filter((candidate) => candidate !== entry);

  const defineLabel = differingDefine(entry, others);
  if (defineLabel !== undefined) {
    return defineLabel;
  }

  const output = outputBasename(entry);
  if (output !== undefined) {
    return output;
  }

  return `unit ${entries.indexOf(entry) + 1}`;
}

function disambiguateLabels(units: Unit[]): Unit[] {
  const occurrences = new Map<string, number>();
  return units.map((unit) => {
    const count = occurrences.get(unit.label) ?? 0;
    occurrences.set(unit.label, count + 1);
    if (count === 0) {
      return unit;
    }
    return { ...unit, label: `${unit.label} #${count + 1}` };
  });
}

export function unitsForFile(profile: Profile, file: string): Unit[] {
  const target = path.resolve(file);
  const seen = new Set<string>();
  const unique: CompileEntry[] = [];
  for (const rawEntry of profile.entries) {
    const entry = normalizeEntry(rawEntry);
    if (entry.file !== target) {
      continue;
    }
    const key = entryKey(entry);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(entry);
  }

  const units = unique
    .map((entry) => ({
      key: entryKey(entry),
      entry,
      label: deriveUnitLabel(unique, entry),
    }))
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return disambiguateLabels(units);
}
