import type { IncludeGraph } from './include-graph.js';

export interface HeaderTreeItem {
  rootFile: string;
  chains: string[][];
}

function historyIndex(history: string[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let cursor = 0; cursor < history.length; cursor += 1) {
    const file = history[cursor];
    if (!index.has(file)) {
      index.set(file, cursor);
    }
  }
  return index;
}

function compareRoots(left: string, right: string, order: Map<string, number>): number {
  const leftIndex = order.get(left);
  const rightIndex = order.get(right);
  if (leftIndex !== undefined && rightIndex !== undefined) {
    return leftIndex - rightIndex;
  }
  if (leftIndex !== undefined) {
    return -1;
  }
  if (rightIndex !== undefined) {
    return 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildHeaderTreeModel(
  graph: IncludeGraph,
  header: string,
  history: string[],
): HeaderTreeItem[] {
  const chainsByRoot = new Map<string, string[][]>();
  for (const root of graph.rootsFor(header)) {
    const chains = chainsByRoot.get(root.rootFile);
    if (chains === undefined) {
      chainsByRoot.set(root.rootFile, [root.chain]);
    } else {
      chains.push(root.chain);
    }
  }

  const order = historyIndex(history);
  const rootFiles = [...chainsByRoot.keys()].sort((left, right) =>
    compareRoots(left, right, order),
  );
  return rootFiles.map((rootFile) => ({
    rootFile,
    chains: chainsByRoot.get(rootFile) ?? [],
  }));
}
