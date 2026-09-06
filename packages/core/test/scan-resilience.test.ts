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

/**
 * A lister that reports how many calls were ever in flight at once.
 *
 * Parallelism used to be inferred from a stopwatch — five 300ms probes finishing in
 * under 900ms. That measures the machine: under load a genuinely parallel scan misses
 * the bound and the suite fails for a reason that has nothing to do with the code.
 * Counting overlap asserts the property itself and cannot be wrong about it.
 *
 * The yield is a microtask rather than a timer, so nothing here waits on a clock: every
 * call that was started together reaches it before any of them resumes. Started one at
 * a time, each would finish before the next began and the peak would be one.
 */
function overlapping(): { lister: McpLister; peak: () => number } {
  let inFlight = 0;
  let peak = 0;

  return {
    lister: {
      listTools: async (server) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return [{ name: `${server}_get_thing` }];
      },
    },
    peak: () => peak,
  };
}

describe('a scan of a real-sized machine', () => {
  it('probes servers in parallel, so five timeouts do not cost five timeouts', async () => {
    const { lister, peak } = overlapping();

    const report = await discover(reader(), {
      now: new Date().toISOString(),
      lister,
      env: {},
    });

    expect(report.probed).toHaveLength(5);
    // Serial would peak at one. Five at once is the whole point of the parallel probe.
    expect(peak()).toBe(5);
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
