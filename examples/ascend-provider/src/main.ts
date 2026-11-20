#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeProfileSets } from '@mp-clangd/core';
import { buildProfileSetFromCdbs, discoverCompileCommands } from '@mp-clangd/provider-cdb';
import { harvestEntriesFromLog } from './harvest.js';
import { loadPreset } from './preset.js';
import { buildAscendProfileSet, probeEntry } from './provider.js';

const DEFAULT_PRESET = fileURLToPath(new URL('../preset.yaml', import.meta.url));
const USAGE = [
  'usage: ascend-provider [options]',
  '',
  'Options:',
  '  --workspace <dir>  workspace root (default: current directory)',
  '  --preset <file>    preset file (default: preset.yaml next to the provider)',
  '  --cdb <file>       compile_commands.json to read (repeatable; default: auto-discover)',
  '  --build-log <file> build log to harvest bisheng entries from',
  '  --help             show this help',
].join('\n');

interface Options {
  workspace: string;
  preset: string;
  cdbs: string[];
  buildLog?: string;
}

type ParsedArgs = { help: true } | { help: false; options: Options };

function parseArgs(argv: string[]): ParsedArgs {
  let workspace = process.cwd();
  let preset = DEFAULT_PRESET;
  const cdbs: string[] = [];
  let buildLog: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') {
      return { help: true };
    }
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`${flag} requires a value`);
    }
    index += 1;
    switch (flag) {
      case '--workspace':
        workspace = path.resolve(value);
        break;
      case '--preset':
        preset = path.resolve(value);
        break;
      case '--cdb':
        cdbs.push(path.resolve(value));
        break;
      case '--build-log':
        buildLog = path.resolve(value);
        break;
      default:
        throw new Error(`unknown option "${flag}"`);
    }
  }

  return { help: false, options: { workspace, preset, cdbs, buildLog } };
}

function readBuildLog(buildLogPath: string): string {
  try {
    return readFileSync(buildLogPath, 'utf8');
  } catch (error) {
    throw new Error(`${buildLogPath}: failed to read build log`, { cause: error });
  }
}

async function run(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const { workspace, preset: presetPath, cdbs, buildLog } = parsed.options;
  const preset = loadPreset(presetPath);
  const cdbPaths = cdbs.length > 0 ? cdbs : await discoverCompileCommands(workspace);
  let base = await buildProfileSetFromCdbs(cdbPaths, workspace);
  if (buildLog !== undefined) {
    const entries = harvestEntriesFromLog(readBuildLog(buildLog), workspace);
    base = mergeProfileSets([base, { profiles: [{ id: 'harvested', entries }] }]);
  }
  const cacheDir = path.join(workspace, '.mpclangd', 'cache');
  const set = await buildAscendProfileSet(base, preset, probeEntry, cacheDir);
  process.stdout.write(`${JSON.stringify(set, null, 2)}\n`);
}

run(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
});
