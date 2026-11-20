import type { ProviderFactory } from '@mp-clangd/core';
import { buildProfileSetFromCdbs } from './build.js';
import { discoverCompileCommands } from './discover.js';

export * from './discover.js';
export * from './parse-cdb.js';
export * from './build.js';

export function createCdbProvider(): ProviderFactory {
  return async ({ workspaceDir, config }) => {
    const options = config.use === 'builtin:cdb'
      ? { include: config.include, exclude: config.exclude }
      : {};
    const cdbPaths = await discoverCompileCommands(workspaceDir, options);
    return buildProfileSetFromCdbs(cdbPaths, workspaceDir);
  };
}
