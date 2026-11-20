import { readFileSync } from 'node:fs';
import type { CompileEntry } from '@mp-clangd/core';
import { parse as parseYaml } from 'yaml';

export interface PresetPass {
  name: string;
  arch_suffix: string;
  macros: string[];
}

export interface Preset {
  name: string;
  match: {
    compilers: string[];
    args_any: string[];
  };
  probe: {
    parse: 'cc1';
    passes: PresetPass[];
  };
  sanitize: {
    remove_args: string[];
    add_args: string[];
    keyword_defines: string[];
  };
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value;
}

function asStringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array of strings`);
  }
  return value.map((item, index) => asString(item, `${context}[${index}]`));
}

function parsePass(value: unknown, context: string): PresetPass {
  const record = asRecord(value, context);
  return {
    name: asString(record.name, `${context}.name`),
    arch_suffix: asString(record.arch_suffix, `${context}.arch_suffix`),
    macros: asStringArray(record.macros, `${context}.macros`),
  };
}

export function loadPreset(presetPath: string): Preset {
  let text: string;
  try {
    text = readFileSync(presetPath, 'utf8');
  } catch (error) {
    throw new Error(`${presetPath}: failed to read preset`, { cause: error });
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new Error(`${presetPath}: invalid YAML`, { cause: error });
  }

  const root = asRecord(raw, presetPath);
  const match = asRecord(root.match, `${presetPath}: match`);
  const probe = asRecord(root.probe, `${presetPath}: probe`);
  if (probe.parse !== 'cc1') {
    throw new Error(`${presetPath}: probe.parse must be "cc1"`);
  }
  if (!Array.isArray(probe.passes) || probe.passes.length === 0) {
    throw new Error(`${presetPath}: probe.passes must be a non-empty array`);
  }
  const sanitize = asRecord(root.sanitize, `${presetPath}: sanitize`);

  return {
    name: asString(root.name, `${presetPath}: name`),
    match: {
      compilers: asStringArray(match.compilers, `${presetPath}: match.compilers`),
      args_any: asStringArray(match.args_any, `${presetPath}: match.args_any`),
    },
    probe: {
      parse: 'cc1',
      passes: probe.passes.map((pass: unknown, index: number) =>
        parsePass(pass, `${presetPath}: probe.passes[${index}]`),
      ),
    },
    sanitize: {
      remove_args: asStringArray(sanitize.remove_args, `${presetPath}: sanitize.remove_args`),
      add_args: asStringArray(sanitize.add_args, `${presetPath}: sanitize.add_args`),
      keyword_defines: asStringArray(
        sanitize.keyword_defines,
        `${presetPath}: sanitize.keyword_defines`,
      ),
    },
  };
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function compilerBasename(compiler: string): string {
  const parts = compiler.split(/[\\/]/);
  return parts[parts.length - 1] ?? compiler;
}

function argumentCandidates(args: string[]): string[] {
  const candidates = [...args];
  for (let index = 0; index + 1 < args.length; index += 1) {
    candidates.push(`${args[index]} ${args[index + 1]}`);
  }
  return candidates;
}

export function matchesPreset(entry: CompileEntry, preset: Preset): boolean {
  const compiler = entry.arguments[0];
  if (compiler === undefined) {
    return false;
  }
  const basename = compilerBasename(compiler);
  if (!preset.match.compilers.some((glob) => globToRegExp(glob).test(basename))) {
    return false;
  }
  const candidates = argumentCandidates(entry.arguments);
  return preset.match.args_any.some((value) => candidates.includes(value));
}
