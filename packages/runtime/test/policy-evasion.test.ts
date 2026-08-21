import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer, type MemnoxServer } from '../src/server';

const ADMIN = ['evasion', 'admin', 'token'].join('-');
const POLICY = `version: 1
policies:
  - name: block-prod-delete
    match:
      actions: ["database.delete"]
      environments: ["production"]
    decision:
      effect: block
      reason: no deletes in prod
`;

/** A name that misses the rule naming it is the whole product failing. */
describe('dressing an action up to miss the rule that names it', () => {
  let dataDir: string;
  let server: MemnoxServer;
  let agentToken: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-evasion-'));
    const policies = join(dataDir, 'policies.yaml');
    await writeFile(policies, POLICY, 'utf8');
    server = await buildServer({ dataDir, adminToken: ADMIN, policyFile: policies });

    const registered = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { name: 'evader', kind: 'mcp' },
    });
    agentToken = (registered.json() as { token: string }).token;
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function effectOf(action: string, environment: string): Promise<string> {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { action, environment },
    });
    return (response.json() as { effect: string }).effect;
  }

  it('blocks the action named exactly', async () => {
    expect(await effectOf('database.delete', 'production')).toBe('block');
  });

  it.each([
    ['a trailing space', 'database.delete ', 'production'],
    ['a leading space', ' database.delete', 'production'],
    ['a trailing tab', 'database.delete\t', 'production'],
    ['a trailing newline', 'database.delete\n', 'production'],
    ['a zero-width space', 'database.delete​', 'production'],
    ['padding on the environment', 'database.delete', 'production '],
    ['a newline on the environment', 'database.delete', '\nproduction'],
  ])('blocks it just the same with %s', async (_name, action, environment) => {
    expect(await effectOf(action, environment)).toBe('block');
  });

  /** The audit trail has to show the request that was actually ruled on. */
  it('records the canonical name, not the padded one', async () => {
    await effectOf('database.delete ', 'production');

    const events = await server.gateway.queryAuditEvents({});
    const blocked = events.filter((event) => event.action.includes('delete'));
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.action).toBe('database.delete');
  });
});
