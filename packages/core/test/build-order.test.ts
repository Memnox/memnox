import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** tsup reads a dependency's `.d.ts` from its dist, so build order has to be real. */
const WORKSPACE_PREFIX = '@memnox/';

const repoPath = (relative: string): string =>
  fileURLToPath(new URL(`../../../${relative}`, import.meta.url));

const readJson = (relative: string): Record<string, unknown> =>
  JSON.parse(readFileSync(repoPath(relative), 'utf8')) as Record<string, unknown>;

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
    graph.set(
      pkg['name'] as string,
      Object.keys(declared).filter((name) => name.startsWith(WORKSPACE_PREFIX)),
    );
  }
  return graph;
}

describe('the workspace', () => {
  it('builds recursively, so pnpm orders the graph rather than a hand-written list', () => {
    const scripts = readJson('package.json')['scripts'] as Record<string, string>;
    expect(scripts['build']).toContain('pnpm -r');
  });

  it('declares every internal dependency with the workspace protocol', () => {
    const offenders: string[] = [];
    for (const dir of readdirSync(repoPath('packages'))) {
      const manifest = `packages/${dir}/package.json`;
      if (!existsSync(repoPath(manifest))) continue;
      const pkg = readJson(manifest);
      const deps = (pkg['dependencies'] as Record<string, string>) ?? {};
      for (const [name, range] of Object.entries(deps)) {
        if (name.startsWith(WORKSPACE_PREFIX) && !range.startsWith('workspace:')) {
          offenders.push(`${pkg['name'] as string} pins ${name} at ${range}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /** A cycle is the one thing pnpm's topological sort cannot resolve for us. */
  it('has no dependency cycle', () => {
    const graph = workspaceDependencies();
    const state = new Map<string, 'open' | 'done'>();
    const cycles: string[] = [];

    const walk = (name: string, trail: string[]): void => {
      if (state.get(name) === 'done') return;
      if (state.get(name) === 'open') {
        cycles.push([...trail, name].join(' -> '));
        return;
      }
      state.set(name, 'open');
      for (const next of graph.get(name) ?? []) walk(next, [...trail, name]);
      state.set(name, 'done');
    };

    for (const name of graph.keys()) walk(name, []);
    expect(cycles).toEqual([]);
  });
});
