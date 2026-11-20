import * as path from 'node:path';
import { parseProfileSet } from '@mp-clangd/core';
import type { Profile, ProfileSet } from '@mp-clangd/core';
import { parseCdbFile } from './parse-cdb.js';

function profileIdFor(cdbPath: string, workspaceDir: string, used: Set<string>): string {
  const directory = path.dirname(path.resolve(cdbPath));
  const relative = path.relative(path.resolve(workspaceDir), directory);
  const base = relative === '' ? 'default' : relative.split(path.sep).join('/');
  let id = base;
  let suffix = 2;
  while (used.has(id)) {
    id = `${base}#${suffix}`;
    suffix += 1;
  }
  used.add(id);
  return id;
}

export async function buildProfileSetFromCdbs(
  cdbPaths: string[],
  workspaceDir: string,
): Promise<ProfileSet> {
  const usedIds = new Set<string>();
  const profiles: Profile[] = cdbPaths.map((cdbPath) => ({
    id: profileIdFor(cdbPath, workspaceDir, usedIds),
    entries: parseCdbFile(cdbPath),
  }));
  return parseProfileSet({ profiles });
}
