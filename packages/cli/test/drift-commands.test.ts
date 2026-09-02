import { describe, expect, it } from 'vitest';
import type { McpLister } from '@memnox/discovery';
import { registerDiffCommand } from '../src/commands/diff.command';
import { registerWatchCommand } from '../src/commands/watch.command';
import { registerTraceCommand } from '../src/commands/trace.command';
import { runCommand } from './cli-harness';
import {
  fakeSeams,
  FakeMachine,
  HOME,
  MemorySnapshots,
  StubLister,
} from './machine-harness';

const CLAUDE_CONFIG = `${HOME}/.claude.json`;

function machineWith(servers: Record<string, { command: string; args: string[] }>) {
  return FakeMachine.from({
    [CLAUDE_CONFIG]: JSON.stringify({ mcpServers: servers }),
  });
}

const GITHUB = { github: { command: 'npx', args: ['github-mcp'] } };
const GITHUB_AND_STRIPE = {
  ...GITHUB,
  stripe: { command: 'npx', args: ['stripe-mcp'] },
};

/** Two scans, so a drift report has something true to compare against. */
async function scanTwice(
  first: FakeMachine,
  second: FakeMachine,
  lister: () => McpLister,
): Promise<{ snapshots: MemorySnapshots; text: string }> {
  const snapshots = new MemorySnapshots();
  await runCommand(
    (program, context) =>
      registerDiffCommand(program, context, () =>
        fakeSeams(first, { lister, snapshots, times: ['2026-01-01T09:00:00.000Z'] }),
      ),
    ['diff'],
  );
  const { out } = await runCommand(
    (program, context) =>
      registerDiffCommand(program, context, () =>
        fakeSeams(second, { lister, snapshots, times: ['2026-01-02T09:00:00.000Z'] }),
      ),
    ['diff'],
  );
  return { snapshots, text: out.text };
}

describe('memnox diff', () => {
  /* A first run has nothing to compare against, and inventing a baseline would be
     worse than saying so. */
  it('says the first scan is the baseline rather than reporting nothing changed', async () => {
    const { out } = await runCommand(
      (program, context) =>
        registerDiffCommand(program, context, () => fakeSeams(machineWith(GITHUB))),
      ['diff'],
    );

    expect(out.text).toContain('No earlier scan');
  });

  it('names a server that arrived, and the file that granted it', async () => {
    const { text } = await scanTwice(
      machineWith(GITHUB),
      machineWith(GITHUB_AND_STRIPE),
      () =>
        new StubLister({ stripe: [{ name: 'create_refund' }, { name: 'get_charge' }] }),
    );

    expect(text).toContain('stripe');
    expect(text).toContain('«server»');
    expect(text).toContain(CLAUDE_CONFIG);
    expect(text).toContain('1 change widens authority');
  });

  it('names a server that went, on the narrowing side', async () => {
    const { text } = await scanTwice(
      machineWith(GITHUB_AND_STRIPE),
      machineWith(GITHUB),
      () => new StubLister(),
    );

    expect(text).toContain('stripe');
    expect(text).toContain('removed');
    expect(text).toContain('1 narrows it');
  });

  it('reports nothing when nothing moved', async () => {
    const { text } = await scanTwice(
      machineWith(GITHUB),
      machineWith(GITHUB),
      () => new StubLister([{ name: 'get_issue' }]),
    );

    expect(text).toContain('Nothing moved');
  });
});

describe('memnox watch', () => {
  /** The arrival is the whole point: a server nothing covers, named with its tools. */
  it('reports an arriving server and that no rule covers it', async () => {
    const snapshots = new MemorySnapshots();
    const lister = (): McpLister =>
      new StubLister({
        stripe: [{ name: 'create_refund' }, { name: 'delete_customer' }],
      });

    await runCommand(
      (program, context) =>
        registerWatchCommand(
          program,
          context,
          () =>
            fakeSeams(machineWith(GITHUB), {
              lister,
              snapshots,
              times: ['2026-01-01T09:00:00.000Z'],
            }),
          () => '/srv/checkout',
          async () => undefined,
        ),
      ['watch', '--cycles', '1'],
    );

    const { out } = await runCommand(
      (program, context) =>
        registerWatchCommand(
          program,
          context,
          () =>
            fakeSeams(machineWith(GITHUB_AND_STRIPE), {
              lister,
              snapshots,
              times: ['2026-01-02T09:00:00.000Z'],
            }),
          () => '/srv/checkout',
          async () => undefined,
        ),
      ['watch', '--cycles', '1'],
    );

    expect(out.text).toContain('NEW MCP SERVER');
    expect(out.text).toContain('stripe');
    expect(out.text).toContain('1 destructive');
    expect(out.text).toContain('No rule covers any of them.');
  });

  /** A watch that slept a real minute between cycles would never be run in a test. */
  it('waits between cycles and prints nothing when nothing moved', async () => {
    const waits: number[] = [];
    const snapshots = new MemorySnapshots();

    const { out } = await runCommand(
      (program, context) =>
        registerWatchCommand(
          program,
          context,
          () => fakeSeams(machineWith(GITHUB), { snapshots }),
          () => '/srv/checkout',
          async (milliseconds) => {
            waits.push(milliseconds);
          },
        ),
      ['watch', '--cycles', '3', '--interval', '5'],
    );

    expect(waits).toEqual([5_000, 5_000]);
    expect(out.text).toBe('');
  });
});

describe('memnox trace', () => {
  it('names the server, the config that granted it, and when it first appeared', async () => {
    const snapshots = new MemorySnapshots();
    const lister = (): McpLister =>
      new StubLister({ stripe: [{ name: 'create_refund' }] });

    // The first scan holds only github, so the tool's arrival has a date.
    await runCommand(
      (program, context) =>
        registerTraceCommand(program, context, () =>
          fakeSeams(machineWith(GITHUB), {
            snapshots,
            times: ['2026-01-01T09:00:00.000Z'],
          }),
        ),
      ['trace', 'create_refund'],
    );

    const { out } = await runCommand(
      (program, context) =>
        registerTraceCommand(program, context, () =>
          fakeSeams(machineWith(GITHUB_AND_STRIPE), {
            lister,
            snapshots,
            times: ['2026-01-08T09:00:00.000Z'],
          }),
        ),
      ['trace', 'create_refund'],
    );

    expect(out.text).toContain('stripe');
    expect(out.text).toContain(CLAUDE_CONFIG);
    expect(out.text).toContain('2026-01-08T09:00:00.000Z');
    expect(out.text).toContain('WRITE');
  });

  it('offers the near misses when the name is not on this machine', async () => {
    const { out } = await runCommand(
      (program, context) =>
        registerTraceCommand(program, context, () =>
          fakeSeams(machineWith(GITHUB), {
            lister: () => new StubLister([{ name: 'merge_pull_request' }]),
          }),
        ),
      ['trace', 'merge'],
    );

    expect(out.text).toContain('No tool named "merge"');
    expect(out.text).toContain('merge_pull_request');
  });
});
