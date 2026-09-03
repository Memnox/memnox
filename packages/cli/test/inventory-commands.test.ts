import { describe, expect, it } from 'vitest';
import { AGENT_KIND, AGENT_STATUS } from '@memnox/core';
import { registerAgentsCommand } from '../src/commands/agents.command';
import { registerDiscoverCommand } from '../src/commands/discover.command';
import { registerDoctorCommand } from '../src/commands/doctor.command';
import { FakeRuntime, runCommand } from './cli-harness';
import { fakeSeams, FakeMachine, HOME, StubLister } from './machine-harness';

const AGENTS_PATH = '/v1/agents';

const MACHINE = {
  [`${HOME}/.claude.json`]: JSON.stringify({
    mcpServers: {
      stripe: {
        command: 'npx',
        args: ['stripe-mcp'],
        env: { STRIPE_SECRET_KEY: 'sk_live_x', STRIPE_ACCOUNT: 'acct_1' },
      },
    },
  }),
  [`${HOME}/.aws/credentials`]: '[default]\naws_access_key_id = AKIAEXAMPLE',
};

describe('the words people reach for', () => {
  it('answers to "scan" as well as to "discover"', async () => {
    const machine = FakeMachine.from(MACHINE);

    const { out } = await runCommand(
      (program, context) =>
        registerDiscoverCommand(program, context, () => fakeSeams(machine)),
      ['scan'],
    );

    expect(out.text).toContain('AI AGENTS');
  });
});

describe('memnox --tools, as a review of what a server asked for', () => {
  it('names the credentials a config hands a server, and never a value', async () => {
    const machine = FakeMachine.from(MACHINE);
    const lister = () => new StubLister({ stripe: [{ name: 'create_refund' }] });

    const { out } = await runCommand(
      (program, context) =>
        registerDiscoverCommand(program, context, () => fakeSeams(machine, { lister })),
      ['discover', '--tools'],
    );

    expect(out.text).toContain('STRIPE_SECRET_KEY');
    // The name answers "what does this thing get"; the value stays in the file.
    expect(out.text).not.toContain('sk_live_x');
  });
});

describe('memnox doctor --by-agent', () => {
  it('puts the agents side by side and refuses to rate the products', async () => {
    const machine = FakeMachine.from(MACHINE);

    const { out } = await runCommand(
      (program, context) =>
        registerDoctorCommand(
          program,
          context,
          () => machine,
          () => '/srv/checkout',
        ),
      ['doctor', '--by-agent'],
    );

    expect(out.text).toContain('ON THIS MACHINE');
    expect(out.text).toContain('claude-code');
    expect(out.text).toContain('never a safety');
  });
});

describe('memnox agents unregistered', () => {
  it('names an agent acting here through no identity this runtime issued', async () => {
    const machine = FakeMachine.from(MACHINE);
    const runtime = new FakeRuntime().on('GET', AGENTS_PATH, []);

    const { out } = await runCommand(
      (program, context) =>
        registerAgentsCommand(program, context, () => fakeSeams(machine)),
      ['agents', 'unregistered', '--admin-token', 'adm_test'],
      runtime,
    );

    expect(out.text).toContain('UNREGISTERED');
    expect(out.text).toContain('claude-code');
    expect(out.text).toContain('unclaimed');
    // A row with evidence, not an absence.
    expect(out.text).toContain(`${HOME}/.claude.json`);
  });

  it('says so plainly when every agent here is enrolled', async () => {
    const machine = FakeMachine.from(MACHINE);
    const runtime = new FakeRuntime().on('GET', AGENTS_PATH, [
      {
        id: 'agt_1',
        name: 'claude-code',
        kind: AGENT_KIND.CLAUDE_CODE,
        status: AGENT_STATUS.ACTIVE,
        stats: { allowed: 1, withheld: 0, approvalsRequested: 0 },
      },
    ]);

    const { out } = await runCommand(
      (program, context) =>
        registerAgentsCommand(program, context, () => fakeSeams(machine)),
      ['agents', 'unregistered', '--admin-token', 'adm_test'],
      runtime,
    );

    expect(out.text).toContain('Every agent on this machine is enrolled');
  });
});
