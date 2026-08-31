import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemnoxClient, type HttpTransport } from '@memnox/sdk';
import { buildServer, type MemnoxServer } from '@memnox/runtime';

/** The seam nothing else covered: real client code against real server code. */
function injectTransport(server: MemnoxServer): HttpTransport {
  return async (url, init) => {
    const response = await server.app.inject({
      method: init.method as 'GET' | 'POST' | 'PUT' | 'DELETE',
      url: new URL(url).pathname + new URL(url).search,
      headers: init.headers,
      ...(init.body === undefined ? {} : { payload: init.body }),
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: { 'content-type': response.headers['content-type'] as string },
    });
  };
}

describe('the SDK against a running runtime', () => {
  let dataDir: string;
  let policyFile: string;
  let server: MemnoxServer;
  let client: MemnoxClient;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-sdk-http-'));
    policyFile = join(dataDir, 'memnox.policies.yaml');
    await writeFile(
      policyFile,
      'version: 1\npolicies:\n  - name: seed\n    match:\n      actions: ["deploy.*"]\n    decision:\n      effect: withhold\n      reason: seeded\n',
      'utf8',
    );
    server = await buildServer({ dataDir, policyFile });
    client = new MemnoxClient({
      baseUrl: 'http://runtime.test',
      fetch: injectTransport(server),
    });
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('rotates an agent token', async () => {
    const registered = await client.registerAgent('claude-code', 'claude-code');
    const rotated = await client.rotateAgent(registered.agent.id);

    expect(rotated.token).not.toBe(registered.token);
    expect(rotated.agent.id).toBe(registered.agent.id);
  });

  it('reloads policies', async () => {
    await expect(client.reloadPolicies()).resolves.toMatchObject({ reloaded: true });
  });

  it('rolls a policy set back to an earlier version', async () => {
    // Rollback reads the history, so the target has to be a version this
    // runtime applied rather than the one it booted with.
    const first = await client.applyPolicies([
      {
        name: 'first',
        match: { actions: ['deploy.*'] },
        decision: { effect: 'withhold', reason: 'first version' },
      },
    ]);
    await client.applyPolicies([
      {
        name: 'second',
        match: { actions: ['file.write'] },
        decision: { effect: 'withhold', reason: 'second version' },
      },
    ]);

    const restored = await client.rollbackPolicies(first.version);
    expect(restored).toMatchObject({ rolledBack: true, restoredFrom: first.version });
    expect((await client.policies()).policyNames).toEqual(['first']);
  });

  it('reads a decision back out of the audit trail', async () => {
    const registered = await client.registerAgent('deployer', 'custom');
    const agent = new MemnoxClient({
      baseUrl: 'http://runtime.test',
      token: registered.token,
      fetch: injectTransport(server),
    });

    const decision = await agent.check({ action: 'deploy.service', target: 'api' });
    expect(decision.effect).toBe('withhold');

    const audit = await client.recentAudit(5);
    expect(audit.some((event) => event.id === decision.eventId)).toBe(true);
  });
});
