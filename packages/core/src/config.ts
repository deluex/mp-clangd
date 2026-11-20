import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parse } from 'yaml';

export interface BuiltinCdbProviderConfig {
  use: 'builtin:cdb';
  include?: string[];
  exclude?: string[];
}

export interface CommandProviderConfig {
  use: 'command';
  command: string[];
  config?: string;
  output?: string;
}

export type ProviderConfig = BuiltinCdbProviderConfig | CommandProviderConfig;

export interface MpClangdConfig {
  providers: ProviderConfig[];
}

const CONFIG_FILE_NAME = 'mp_clangd.yaml';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array of strings`);
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error(`${context} must be an array of strings`);
    }
    result.push(item);
  }
  return result;
}

function parseOptionalString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value;
}

function parseProvider(value: unknown, index: number): ProviderConfig {
  const context = `${CONFIG_FILE_NAME}: providers[${index}]`;
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object`);
  }
  const { use } = value;
  if (use === 'builtin:cdb') {
    const provider: BuiltinCdbProviderConfig = { use };
    if (value.include !== undefined) {
      provider.include = parseStringArray(value.include, `${context}.include`);
    }
    if (value.exclude !== undefined) {
      provider.exclude = parseStringArray(value.exclude, `${context}.exclude`);
    }
    return provider;
  }
  if (use === 'command') {
    const provider: CommandProviderConfig = {
      use,
      command: parseStringArray(value.command, `${context}.command`),
    };
    if (value.config !== undefined) {
      provider.config = parseOptionalString(value.config, `${context}.config`);
    }
    if (value.output !== undefined) {
      provider.output = parseOptionalString(value.output, `${context}.output`);
    }
    return provider;
  }
  throw new Error(`${context}.use must be "builtin:cdb" or "command"`);
}

export function loadConfig(workspaceDir: string): MpClangdConfig {
  const file = path.join(workspaceDir, CONFIG_FILE_NAME);
  if (!existsSync(file)) {
    return { providers: [{ use: 'builtin:cdb' }] };
  }

  let document: unknown;
  try {
    document = parse(readFileSync(file, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to parse ${CONFIG_FILE_NAME}: ${message}`);
  }

  if (!isRecord(document) || !Array.isArray(document.providers)) {
    throw new Error(`${CONFIG_FILE_NAME}: "providers" must be an array`);
  }
  return {
    providers: document.providers.map((provider, index) => parseProvider(provider, index)),
  };
}
