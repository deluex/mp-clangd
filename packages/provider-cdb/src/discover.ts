import * as path from 'node:path';
import fg from 'fast-glob';

export interface DiscoverCompileCommandsOptions {
  include?: string[];
  exclude?: string[];
  maxDepth?: number;
}

const DEFAULT_INCLUDE = [
  'compile_commands.json',
  'build*/**/compile_commands.json',
  'out/**/compile_commands.json',
  'cmake-build-*/**/compile_commands.json',
];

const DEFAULT_EXCLUDE = ['.git/**', 'node_modules/**', '.tmp/**', '.mpclangd/**'];

export async function discoverCompileCommands(
  workspaceDir: string,
  opts: DiscoverCompileCommandsOptions = {},
): Promise<string[]> {
  const matches = await fg(opts.include ?? DEFAULT_INCLUDE, {
    cwd: workspaceDir,
    onlyFiles: true,
    unique: true,
    deep: opts.maxDepth ?? 4,
    absolute: true,
    ignore: opts.exclude ?? DEFAULT_EXCLUDE,
  });
  return matches.map((match) => path.resolve(match)).sort();
}
