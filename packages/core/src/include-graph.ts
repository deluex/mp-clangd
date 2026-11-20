import { realpathSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { CompileEntry } from './types.js';

export interface RootPath {
  rootFile: string;
  chain: string[];
}

export interface IncludeGraph {
  rootsFor(header: string): RootPath[];
}

export interface IncludeSearchPaths {
  quote: string[];
  angle: string[];
}

export interface ParsedInclude {
  header: string;
  angle: boolean;
}

const DEFAULT_MAX_FILES = 5000;
const INCLUDE_PATTERN = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm;

export class IncludeGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncludeGraphError';
  }
}

export function extractIncludePaths(args: string[]): IncludeSearchPaths {
  const quote: string[] = [];
  const angle: string[] = [];

  const takeSeparate = (target: string[], index: number): number => {
    const value = args[index + 1];
    if (value !== undefined && value !== '') {
      target.push(value);
      return index + 1;
    }
    return index;
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-iquote') {
      index = takeSeparate(quote, index);
    } else if (arg.startsWith('-iquote') && arg.length > '-iquote'.length) {
      quote.push(arg.slice('-iquote'.length));
    } else if (arg === '-I' || arg === '-isystem' || arg === '-idirafter') {
      index = takeSeparate(angle, index);
    } else if (arg.startsWith('-isystem') && arg.length > '-isystem'.length) {
      angle.push(arg.slice('-isystem'.length));
    } else if (arg.startsWith('-idirafter') && arg.length > '-idirafter'.length) {
      angle.push(arg.slice('-idirafter'.length));
    } else if (arg.startsWith('-I') && arg.length > '-I'.length) {
      angle.push(arg.slice('-I'.length));
    }
  }

  return { quote, angle };
}

export async function parseIncludes(file: string): Promise<ParsedInclude[]> {
  const text = await readFile(file, 'utf8');
  const includes: ParsedInclude[] = [];
  for (const match of text.matchAll(INCLUDE_PATTERN)) {
    const line = match[0];
    const opener = line.search(/[<"]/);
    includes.push({ header: match[1], angle: line[opener] === '<' });
  }
  return includes;
}

export function chooseRoot(
  paths: RootPath[],
  opts: { originFile?: string; history?: string[] },
): RootPath | undefined {
  if (paths.length === 0) {
    return undefined;
  }

  if (opts.originFile !== undefined) {
    const origin = paths.find((candidate) => candidate.rootFile === opts.originFile);
    if (origin !== undefined) {
      return origin;
    }
  }

  for (const file of opts.history ?? []) {
    const previous = paths.find((candidate) => candidate.rootFile === file);
    if (previous !== undefined) {
      return previous;
    }
  }

  return [...paths].sort((left, right) => compareFile(left.rootFile, right.rootFile))[0];
}

function compareFile(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  if (relative === '' || relative === '..' || path.isAbsolute(relative)) {
    return false;
  }
  return !relative.startsWith(`..${path.sep}`);
}

async function realFile(file: string): Promise<string | undefined> {
  try {
    const canonical = await realpath(file);
    const info = await stat(canonical);
    return info.isFile() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function lookupKey(file: string): string {
  const resolved = path.resolve(file);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function searchPathsFor(entry: CompileEntry): IncludeSearchPaths {
  const extracted = extractIncludePaths(entry.arguments);
  return {
    quote: extracted.quote.map((directory) => path.resolve(entry.directory, directory)),
    angle: extracted.angle.map((directory) => path.resolve(entry.directory, directory)),
  };
}

interface ResolvedInclude {
  file: string;
  canonical: string;
}

async function resolveInclude(
  include: ParsedInclude,
  includerDirectory: string,
  searchPaths: IncludeSearchPaths,
  realWorkspace: string,
): Promise<ResolvedInclude | undefined> {
  const directories = include.angle
    ? searchPaths.angle
    : [includerDirectory, ...searchPaths.quote, ...searchPaths.angle];
  const seen = new Set<string>();

  for (const directory of directories) {
    const candidate = path.resolve(directory, include.header);
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    const canonical = await realFile(candidate);
    if (canonical === undefined) {
      continue;
    }
    if (!isInside(realWorkspace, canonical)) {
      // The first existing candidate is the file clang would include, so stop
      // searching instead of falling through to a workspace file.
      return undefined;
    }
    return { file: candidate, canonical };
  }

  return undefined;
}

type RootIndex = Map<string, Map<string, RootPath>>;

function recordRoot(roots: RootIndex, header: string, root: string, chain: string[]): void {
  let byRoot = roots.get(header);
  if (byRoot === undefined) {
    byRoot = new Map<string, RootPath>();
    roots.set(header, byRoot);
  }
  const existing = byRoot.get(root);
  if (existing === undefined || chain.length < existing.chain.length) {
    byRoot.set(root, { rootFile: chain[0], chain });
  }
}

class Graph implements IncludeGraph {
  constructor(private readonly roots: RootIndex) {}

  rootsFor(header: string): RootPath[] {
    const byRoot = this.roots.get(lookupKey(header));
    if (byRoot === undefined) {
      return [];
    }
    return [...byRoot.values()].sort((left, right) =>
      compareFile(left.rootFile, right.rootFile),
    );
  }
}

interface PendingFile {
  file: string;
  canonical: string;
  chain: string[];
}

export async function buildIncludeGraph(
  entries: CompileEntry[],
  opts: { workspaceDir: string; maxFiles?: number },
): Promise<IncludeGraph> {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const roots: RootIndex = new Map();
  let realWorkspace: string | undefined;
  try {
    realWorkspace = await realpath(opts.workspaceDir);
  } catch {
    return new Graph(roots);
  }

  const includesCache = new Map<string, ParsedInclude[]>();
  let fileCount = 0;

  const includesFor = async (canonical: string): Promise<ParsedInclude[]> => {
    const cached = includesCache.get(canonical);
    if (cached !== undefined) {
      return cached;
    }
    fileCount += 1;
    if (fileCount > maxFiles) {
      throw new IncludeGraphError(`include graph exceeded maxFiles limit (${maxFiles})`);
    }
    let includes: ParsedInclude[] = [];
    try {
      includes = await parseIncludes(canonical);
    } catch {
      includes = [];
    }
    includesCache.set(canonical, includes);
    return includes;
  };

  for (const entry of entries) {
    const rootFile = path.resolve(entry.file);
    const rootCanonical = await realFile(rootFile);
    if (rootCanonical === undefined || !isInside(realWorkspace, rootCanonical)) {
      continue;
    }

    const searchPaths = searchPathsFor(entry);
    const visited = new Set<string>([rootCanonical]);
    recordRoot(roots, rootCanonical, rootCanonical, [rootFile]);

    // Breadth-first traversal: the first visit of a file is its shortest chain.
    const queue: PendingFile[] = [{ file: rootFile, canonical: rootCanonical, chain: [rootFile] }];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor];
      const includes = await includesFor(current.canonical);
      const includerDirectory = path.dirname(current.file);
      for (const include of includes) {
        const resolved = await resolveInclude(
          include,
          includerDirectory,
          searchPaths,
          realWorkspace,
        );
        if (resolved === undefined || visited.has(resolved.canonical)) {
          continue;
        }
        visited.add(resolved.canonical);
        const chain = [...current.chain, resolved.file];
        recordRoot(roots, resolved.canonical, rootCanonical, chain);
        queue.push({ file: resolved.file, canonical: resolved.canonical, chain });
      }
    }
  }

  return new Graph(roots);
}
