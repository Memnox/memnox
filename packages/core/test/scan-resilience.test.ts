import { describe, expect, it } from 'vitest';
import { discover } from '../src/discovery/discover';
import type { McpLister } from '../src/discovery/ports';
import type { MachineReader } from '../src/discovery/ports';

const HOME = '/home/dev';

/** Five servers declared by one config, which is an ordinary laptop. */
const CONFIG = JSON.stringify({
  mcpServers: Object.fromEntries(
    ['alpha', 'bravo', 'charlie', 'delta', 'echo'].map((name) => [
      name,
      { command: 'npx', args: ['-y', `@example/${name}`] },
    ]),
  ),
});

function reader(): MachineReader {
  return {
    exists: async (path) => path === `${HOME}/.claude.json`,
    read: async (path) => (path === `${HOME}/.claude.json` ? CONFIG : null),
    list: async () => [],
    homeDir: () => HOME,
    userName: () => 'dev',
  };
}

const PROBE_MS = 300;

/** Answers after a delay, so the test measures wall clock rather than call count. */
const slowLister = (delayMs: number): McpLister => ({
  listTools: async (server) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return [{ name: `${server}_get_thing` }];
  },
});

describe('a scan of a real-sized machine', () => {
  it('probes servers in parallel, so five timeouts do not cost five timeouts', async () => {
    const started = Date.now();
    const report = await discover(reader(), {
      now: new Date().toISOString(),
      lister: slowLister(PROBE_MS),
      env: {},
    });
    const elapsed = Date.now() - started;

    expect(report.probed).toHaveLength(5);
    // Serial would be 5 × PROBE_MS. Parallel is one, plus overhead.
    expect(elapsed).toBeLessThan(PROBE_MS * 3);
  });

  it('finishes when one server hangs, and still reports the other four', async () => {
    const hanging: McpLister = {
      listTools: async (server) => {
        if (server === 'charlie') {
          // What a wedged server looks like: it resolves empty rather than never.
          await new Promise((resolve) => setTimeout(resolve, PROBE_MS * 2));
          return [];
        }
        return [{ name: `${server}_get_thing` }];
      },
    };

    const report = await discover(reader(), {
      now: new Date().toISOString(),
      lister: hanging,
      env: {},
    });

    const tools = report.surfaces.flatMap((surface) => surface.tools ?? []);
    expect(tools.map((tool) => tool.server).sort()).toEqual([
      'alpha',
      'bravo',
      'delta',
      'echo',
    ]);
    // The wedged server is still named as present; zero tools means unknown.
    expect(report.probed.some((line) => line.startsWith('charlie:'))).toBe(true);
  });

  it('never lets a server that refuses outright abort the scan', async () => {
    const angry: McpLister = {
      listTools: async (server) => {
        if (server === 'delta') throw new Error('ENOENT: npx not found');
        return [{ name: `${server}_get_thing` }];
      },
    };

    const report = await discover(reader(), {
      now: new Date().toISOString(),
      lister: angry,
      env: {},
    });

    expect(report.probed).toHaveLength(5);
    const tools = report.surfaces.flatMap((surface) => surface.tools ?? []);
    expect(tools.map((tool) => tool.server)).not.toContain('delta');
    expect(tools).toHaveLength(4);
  });
});
