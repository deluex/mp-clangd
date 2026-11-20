import type { CompileEntry } from '@mp-clangd/core';
import { parse as parseShell } from 'shell-quote';
import type { Preset } from './preset.js';

export interface Cc1Command {
  argv: string[];
  output?: string;
  isHost: boolean;
  isAicore: boolean;
  arch?: string;
}

export interface ProbePass {
  name: string;
  argv: string[];
  output?: string;
  arch?: string;
  /**
   * Set by `probeEntry` after running the pass with `-dM -E`: true when every
   * macro declared by the preset for this pass is defined.
   */
  verified?: boolean;
}

function tokenAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function parseCc1(stderr: string): Cc1Command[] {
  const commands: Cc1Command[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.includes(' -cc1 ')) {
      continue;
    }
    const argv = parseShell(line).filter((token): token is string => typeof token === 'string');
    commands.push({
      argv,
      output: tokenAfter(argv, '-o'),
      isHost: argv.includes('-fcce-is-host'),
      isAicore: argv.includes('-fcce-is-aicore'),
      arch: tokenAfter(argv, '-fcce-aicore-arch'),
    });
  }
  return commands;
}

export function pickPasses(commands: Cc1Command[], preset: Preset): ProbePass[] {
  return preset.probe.passes.map((spec) => {
    const command = commands.find(
      (candidate) =>
        candidate.output?.endsWith(`${spec.arch_suffix}.o`) === true ||
        candidate.arch?.endsWith(spec.arch_suffix) === true,
    );
    if (command === undefined) {
      throw new Error(
        `probe did not emit pass "${spec.name}" (suffix "${spec.arch_suffix}")`,
      );
    }
    return {
      name: spec.name,
      argv: [...command.argv],
      output: command.output,
      arch: command.arch,
    };
  });
}

function tokenMatchesPattern(pattern: string, token: string): boolean {
  if (pattern.endsWith('*')) {
    return token.startsWith(pattern.slice(0, -1));
  }
  return token === pattern;
}

export function sanitizeArgs(args: string[], preset: Preset): string[] {
  const removeArgs = preset.sanitize.remove_args;
  const pairPatterns = removeArgs
    .filter((pattern) => pattern.includes(' '))
    .map((pattern) => pattern.split(/\s+/));
  const tokenPatterns = removeArgs.filter((pattern) => !pattern.includes(' '));

  const kept: string[] = [];
  let index = 0;
  while (index < args.length) {
    const pair = pairPatterns.find((parts) =>
      parts.every((part, offset) => args[index + offset] === part),
    );
    if (pair !== undefined) {
      index += pair.length;
      continue;
    }
    const token = args[index];
    if (!tokenPatterns.some((pattern) => tokenMatchesPattern(pattern, token))) {
      kept.push(token);
    }
    index += 1;
  }

  for (const value of preset.sanitize.add_args) {
    if (!kept.includes(value)) {
      kept.push(value);
    }
  }
  return kept;
}

export function buildClangdArgs(
  entry: CompileEntry,
  pass: ProbePass,
  preset: Preset,
): string[] {
  const args = sanitizeArgs(entry.arguments, preset);
  const spec = preset.probe.passes.find((candidate) => candidate.name === pass.name);
  for (const macro of spec?.macros ?? []) {
    const define = `-D${macro}=1`;
    if (!args.includes(define)) {
      args.push(define);
    }
  }
  for (const keyword of preset.sanitize.keyword_defines) {
    const define = `-D${keyword}=`;
    if (!args.includes(define)) {
      args.push(define);
    }
  }
  return args;
}
