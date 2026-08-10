import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `npm run build` emits declarations, and tsup reads a dependency's `.d.ts` from
 * its `dist`. A package built before something it imports fails with TS7016 —
 * invisibly on a developer machine where a stale `dist` is still lying around,
 * and every time in CI, where there is none.
 */
const WORKSPACE_PREFIX = '@memnox/';
const CLI_PACKAGE = 'memnox';

const repoPath = (relative: string): string =>
  fileURLToPath(new URL(`../../../${relative}`, import.meta.url));

const readJson = (relative: string): Record<string, unknown> =>
  JSON.parse(readFileSync(repoPath(relative), 'utf8')) as Record<string, unknown>;

function buildScriptOrder(): string[] {
  const root = readJson('package.json');
  const scripts = root['scripts'] as Record<string, string | undefined>;
  const build = scripts['build'];
  if (build === undefined) throw new Error('root package.json has no build script');

  const names: string[] = [];
  for (const match of build.matchAll(/-w\s+(\S+)/g)) {
    const name = match[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

function workspaceDependencies(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const dir of readdirSync(repoPath('packages'))) {
    const manifest = `packages/${dir}/package.json`;
    if (!existsSync(repoPath(manifest))) continue;
    const pkg = readJson(manifest);
    const declared = {
      ...((pkg['dependencies'] as Record<string, string>) ?? {}),
      ...((pkg['devDependencies'] as Record<string, string>) ?? {}),
    };
    const internal = Object.keys(declared).filter(
      (name) => name.startsWith(WORKSPACE_PREFIX) || name === CLI_PACKAGE,
    );
    graph.set(pkg['name'] as string, internal);
  }
  return graph;
}

describe('root build script', () => {
  it('builds every workspace package exactly once', () => {
    const order = buildScriptOrder();
    const packages = [...workspaceDependencies().keys()];

    expect([...order].sort()).toEqual([...packages].sort());
    expect(new Set(order).size).toBe(order.length);
  });

  it('builds each package after everything it imports', () => {
    const order = buildScriptOrder();
    const graph = workspaceDependencies();
    const position = new Map(order.map((name, index) => [name, index]));

    const tooLate: string[] = [];
    for (const [name, dependencies] of graph) {
      for (const dependency of dependencies) {
        if (!position.has(dependency)) continue;
        const dependencyIndex = position.get(dependency);
        const packageIndex = position.get(name);
        if (dependencyIndex === undefined || packageIndex === undefined) continue;
        if (dependencyIndex > packageIndex) {
          tooLate.push(`${name} is built before its dependency ${dependency}`);
        }
      }
    }

    expect(tooLate).toEqual([]);
  });
});
