import { describe, expect, it } from 'vitest';
import { AGENT_KIND, AGENT_STATUS } from '@memnox/core';
import { FakeRuntime, runCli } from './cli-harness';

const AGENTS_PATH = '/v1/agents';

const summary = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'agt_1',
  name: 'claude-code',
  kind: AGENT_KIND.CLAUDE_CODE,
  status: AGENT_STATUS.ACTIVE,
  trustScore: 87,
  stats: { allowed: 12, withheld: 3, approvalsRequested: 1 },
  ...over,
});

describe('memnox agents register', () => {
  it('prints the token exactly once, with a warning that it is not shown again', async () => {
    const runtime = new FakeRuntime().on('POST', AGENTS_PATH, {
      agent: summary(),
      token: 'mnx_secret_token',
    });

    const { out } = await runCli(
      ['agents', 'register', '--name', 'claude-code', '--admin-token', 'admin'],
      runtime,
    );

    expect(out.text).toContain('Agent registered: claude-code (agt_1)');
    expect(out.text).toContain('never shown again');
    expect(out.lines.filter((l) => l.includes('mnx_secret_token'))).toHaveLength(1);
  });

  it('defaults the kind to custom and sends the given name', async () => {
    const runtime = new FakeRuntime().on('POST', AGENTS_PATH, {
      agent: summary(),
      token: 't',
    });

    await runCli(['agents', 'register', '--name', 'my-bot'], runtime);

    expect(runtime.requests[0]?.body).toMatchObject({
      name: 'my-bot',
      kind: AGENT_KIND.CUSTOM,
    });
  });

  it('authenticates management calls with the admin token', async () => {
    const runtime = new FakeRuntime().on('POST', AGENTS_PATH, {
      agent: summary(),
      token: 't',
    });

    await runCli(
      ['agents', 'register', '--name', 'bot', '--admin-token', 'admin_secret'],
      runtime,
    );

    expect(runtime.requests[0]?.authorization).toBe('Bearer admin_secret');
  });
});

describe('memnox agents list', () => {
  it('reports trust score and decision counts per agent', async () => {
    const runtime = new FakeRuntime().on('GET', AGENTS_PATH, [summary()]);

    const { out } = await runCli(['agents', 'list'], runtime);

    expect(out.text).toContain('agt_1  claude-code');
    expect(out.text).toContain('trust 87/100');
    expect(out.text).toContain('allowed 12, withheld 3');
  });

  it('says so plainly when no agents are registered', async () => {
    const runtime = new FakeRuntime().on('GET', AGENTS_PATH, []);

    const { out } = await runCli(['agents', 'list'], runtime);

    expect(out.text).toBe('No agents registered.');
  });
});

describe('memnox agents suspend / activate', () => {
  it('suspends an agent by id', async () => {
    const runtime = new FakeRuntime().on(
      'POST',
      `${AGENTS_PATH}/agt_1/status`,
      summary({ status: AGENT_STATUS.SUSPENDED }),
    );

    const { out } = await runCli(['agents', 'suspend', 'agt_1'], runtime);

    expect(runtime.requests[0]?.body).toEqual({ status: AGENT_STATUS.SUSPENDED });
    expect(out.text).toContain(`claude-code is now ${AGENT_STATUS.SUSPENDED}`);
  });

  it('re-activates a suspended agent', async () => {
    const runtime = new FakeRuntime().on(
      'POST',
      `${AGENTS_PATH}/agt_1/status`,
      summary({ status: AGENT_STATUS.ACTIVE }),
    );

    const { out } = await runCli(['agents', 'activate', 'agt_1'], runtime);

    expect(runtime.requests[0]?.body).toEqual({ status: AGENT_STATUS.ACTIVE });
    expect(out.text).toContain(`claude-code is now ${AGENT_STATUS.ACTIVE}`);
  });
});

describe('memnox agents rotate', () => {
  it('prints the new token and warns that the old one is dead', async () => {
    const runtime = new FakeRuntime().on('POST', `${AGENTS_PATH}/agt_1/rotate`, {
      agent: summary(),
      token: 'mnx_rotated',
    });

    const { out } = await runCli(['agents', 'rotate', 'agt_1'], runtime);

    expect(out.text).toContain('previous token no longer works');
    expect(out.text).toContain('mnx_rotated');
  });
});
