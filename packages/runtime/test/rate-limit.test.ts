import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter, InProcessLockService } from '@memnox/core';
import { buildServer, type MemnoxServer } from '../src/server';

const POLICY_YAML = `
version: 1
policies:
  - name: allow-reads
    match:
      actions: ["file.read"]
    decision:
      effect: allow
      reason: Reads are safe
`;

const TEST_LIMIT = 3;

describe('FixedWindowRateLimiter', () => {
  it('allows up to the limit then rejects within the window', async () => {
    const limiter = new FixedWindowRateLimiter(new InProcessLockService());
    const results: boolean[] = [];
    for (let i = 0; i < TEST_LIMIT + 2; i += 1) {
      results.push(await limiter.allow('unit', TEST_LIMIT, 60));
    }
    expect(results).toEqual([true, true, true, false, false]);
  });

  it('treats a zero limit as disabled', async () => {
    const limiter = new FixedWindowRateLimiter(new InProcessLockService());
    for (let i = 0; i < TEST_LIMIT * 10; i += 1) {
      expect(await limiter.allow('disabled', 0, 60)).toBe(true);
    }
  });

  it('counts keys independently', async () => {
    const limiter = new FixedWindowRateLimiter(new InProcessLockService());
    expect(await limiter.allow('a', 1, 60)).toBe(true);
    expect(await limiter.allow('a', 1, 60)).toBe(false);
    expect(await limiter.allow('b', 1, 60)).toBe(true);
  });
});

describe('check endpoint rate limiting', () => {
  let dataDir: string;
  let server: MemnoxServer;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-ratelimit-'));
    const policyFile = join(dataDir, 'policies.yaml');
    await writeFile(policyFile, POLICY_YAML, 'utf8');
    server = await buildServer({
      dataDir,
      policyFile,
      checkRateLimitPerMinute: TEST_LIMIT,
    });
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function registerAgent(name: string): Promise<string> {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { name, kind: 'claude-code' },
    });
    const { token } = response.json() as { token: string };
    return token;
  }

  async function check(token: string): Promise<number> {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'file.read', target: 'README.md', environment: 'development' },
    });
    return response.statusCode;
  }

  it('returns 429 once an agent exceeds its per-minute budget', async () => {
    const token = await registerAgent('greedy-agent');
    for (let i = 0; i < TEST_LIMIT; i += 1) {
      expect(await check(token)).toBe(200);
    }
    expect(await check(token)).toBe(429);
  });

  it('limits per agent, not globally', async () => {
    const first = await registerAgent('first-agent');
    const second = await registerAgent('second-agent');
    for (let i = 0; i < TEST_LIMIT; i += 1) {
      expect(await check(first)).toBe(200);
    }
    expect(await check(first)).toBe(429);
    expect(await check(second)).toBe(200);
  });

  it('does not spend budget on unauthenticated requests', async () => {
    const missing = await server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      payload: { action: 'file.read' },
    });
    expect(missing.statusCode).toBe(401);
  });
});
