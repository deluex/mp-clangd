import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { mergeProfileSets, parseProfileSet } from './profile-set.js';
import type { ProfileSet } from './types.js';
import type { MpClangdConfig, ProviderConfig } from './config.js';

export interface ProviderRunContext {
  workspaceDir: string;
  config: ProviderConfig;
}

export type ProviderFactory = (context: ProviderRunContext) => ProfileSet | Promise<ProfileSet>;

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

const STDERR_LIMIT = 500;

function withStderr(message: string, stderr: string): string {
  const snippet = stderr.slice(0, STDERR_LIMIT);
  return snippet.length > 0 ? `${message}\nstderr: ${snippet}` : message;
}

function substituteWorkspace(token: string, workspaceDir: string): string {
  return token.split('{workspace}').join(workspaceDir);
}

function readOutputFile(workspaceDir: string, output: string): string {
  const outputPath = path.resolve(workspaceDir, substituteWorkspace(output, workspaceDir));
  try {
    return readFileSync(outputPath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderError(`failed to read provider output file "${outputPath}": ${message}`);
  }
}

const commandProvider: ProviderFactory = (context) => {
  const { workspaceDir, config: providerConfig } = context;
  if (providerConfig.use !== 'command') {
    throw new ProviderError(
      `command provider cannot handle config for "${providerConfig.use}"`,
    );
  }
  if (!providerConfig.command || providerConfig.command.length === 0) {
    throw new ProviderError('command provider requires a non-empty "command" array');
  }

  const configPath = providerConfig.config !== undefined
    ? path.resolve(workspaceDir, substituteWorkspace(providerConfig.config, workspaceDir))
    : undefined;
  const command = providerConfig.command.map((token) => {
    const value = substituteWorkspace(token, workspaceDir);
    return configPath !== undefined ? value.split('{config}').join(configPath) : value;
  });
  const [executable, ...args] = command;
  const env = configPath !== undefined
    ? { ...process.env, MP_CLANGD_PROVIDER_CONFIG: configPath }
    : process.env;
  const result = spawnSync(executable, args, { cwd: workspaceDir, encoding: 'utf8', env });
  const stderr = result.stderr ?? '';

  if (result.error) {
    throw new ProviderError(
      `failed to run provider command "${executable}": ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const detail = result.signal
      ? `was terminated by signal ${result.signal}`
      : `exited with code ${result.status}`;
    throw new ProviderError(withStderr(`provider command "${executable}" ${detail}`, stderr));
  }

  const output = providerConfig.output
    ? readOutputFile(workspaceDir, providerConfig.output)
    : result.stdout ?? '';
  if (output.trim().length === 0) {
    throw new ProviderError(withStderr('provider command produced empty output', stderr));
  }

  try {
    return parseProfileSet(JSON.parse(output));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderError(
      withStderr(`provider command produced invalid output: ${message}`, stderr),
    );
  }
};

const providers = new Map<string, ProviderFactory>();

export function registerProvider(use: string, factory: ProviderFactory): void {
  providers.set(use, factory);
}

export function resetProviders(): void {
  providers.clear();
  providers.set('command', commandProvider);
}

export async function runProviders(
  workspaceDir: string,
  config: MpClangdConfig,
): Promise<ProfileSet> {
  const sets: ProfileSet[] = [];
  for (const providerConfig of config.providers) {
    const factory = providers.get(providerConfig.use);
    if (!factory) {
      throw new ProviderError(`unknown provider "${providerConfig.use}"`);
    }
    const result = await factory({ workspaceDir, config: providerConfig });
    sets.push(parseProfileSet(result));
  }
  return mergeProfileSets(sets);
}

resetProviders();
