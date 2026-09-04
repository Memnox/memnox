import { describe, expect, it } from 'vitest';
import type { McpLister } from '@memnox/core';
import { registerScanCommand } from '../src/commands/scan.command';
import { runCommand } from './cli-harness';
import { fakeSeams, FakeMachine, HOME, StubLister } from './machine-harness';

const MACHINE = {
  [`${HOME}/.claude.json`]: JSON.stringify({
    mcpServers: { github: { command: 'npx', args: ['github-mcp'] } },
  }),
};

/** A server with a realistic spread: mostly reads, a few writes, two destructive. */
const GITHUB_TOOLS = [
  { name: 'list_repositories' },
  { name: 'get_issue' },
  { name: 'search_code' },
  { name: 'create_issue' },
  { name: 'merge_pull_request' },
  { name: 'update_file' },
  { name: 'delete_branch' },
  { name: 'delete_repository' },
];

async function tools(lister: () => McpLister) {
  return runCommand(
    (program, context) =>
      registerScanCommand(program, context, () =>
        fakeSeams(FakeMachine.from(MACHINE), { lister }),
      ),
    ['scan', '--tools'],
  );
}

describe('memnox --tools', () => {
  /**
   * "Thirty one tools" is not actionable. "Eight of them change external state" is the
   * only version of that sentence anybody can do something about.
   */
  it('groups by effect and counts what changes external state', async () => {
    const { out } = await tools(() => new StubLister({ github: GITHUB_TOOLS }));

    expect(out.text).toContain('DESTRUCTIVE');
    expect(out.text).toContain('delete_branch');
    expect(out.text).toContain('WRITE');
    expect(out.text).toContain('merge_pull_request');
    expect(out.text).toContain('READ');
    expect(out.text).toContain('list_repositories');
    expect(out.text).toContain('5 of 8 change external state');
  });

  /** How the effect was decided rides along, so a wrong call is arguable. */
  it('states the method behind each classification', async () => {
    const { out } = await tools(() => new StubLister({ github: GITHUB_TOOLS }));

    expect(out.text).toContain('name');
  });

  /** The protocol's own annotation beats a guess off the name. */
  it('prefers a published annotation over the name', async () => {
    const { out } = await tools(
      () =>
        new StubLister({
          github: [{ name: 'delete_branch', annotations: { readOnlyHint: true } }],
        }),
    );

    expect(out.text).toContain('READ');
    expect(out.text).toContain('annotation');
    expect(out.text).toContain('Nothing here is known to change external state.');
  });

  /**
   * An unclassified tool is not evidence of harm, so it is counted as neither rather
   * than folded into the number the reader acts on.
   */
  it('keeps unknown tools out of the external-state count and says so', async () => {
    const { out } = await tools(
      () =>
        new StubLister({
          github: [{ name: 'zork', inputSchema: { properties: { a: {} } } }],
        }),
    );

    expect(out.text).toContain('UNKNOWN');
    expect(out.text).toContain('1 could not be classified');
    expect(out.text).toContain('Nothing here is known to change external state.');
  });

  /** Honest when empty: no probe means no tools, and it says which. */
  it('reads as an answer when nothing was probed', async () => {
    const { out } = await runCommand(
      (program, context) =>
        registerScanCommand(program, context, () => fakeSeams(FakeMachine.from(MACHINE))),
      ['scan', '--tools', '--no-probe'],
    );

    expect(out.text).toContain('No MCP tools found.');
    expect(out.text).toContain('ask each server what it holds');
  });
});
