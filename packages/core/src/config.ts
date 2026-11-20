import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parse } from 'yaml';

export interface ProviderConfig {
  use: string;
  command?: string[];
  output?: string;
}

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

function parseProvider(value: unknown, index: number): ProviderConfig {
  const context = `${CONFIG_FILE_NAME}: providers[${index}]`;
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object`);
  }
  const { use, command, output } = value;
  if (typeof use !== 'string' || use.length === 0) {
    throw new Error(`${context}.use must be a non-empty string`);
  }
  const provider: ProviderConfig = { use };
  if (command !== undefined) {
    provider.command = parseStringArray(command, `${context}.command`);
  }
  if (output !== undefined) {
    if (typeof output !== 'string' || output.length === 0) {
      throw new Error(`${context}.output must be a non-empty string`);
    }
    provider.output = output;
  }
  return provider;
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
