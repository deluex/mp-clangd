import type { ProviderFactory } from '@mp-clangd/core';
import { buildProfileSetFromCdbs } from './build.js';
import { discoverCompileCommands } from './discover.js';

export * from './discover.js';
export * from './parse-cdb.js';
export * from './build.js';

export function createCdbProvider(): ProviderFactory {
  return async ({ workspaceDir }) => {
    const cdbPaths = await discoverCompileCommands(workspaceDir);
    return buildProfileSetFromCdbs(cdbPaths, workspaceDir);
  };
}
