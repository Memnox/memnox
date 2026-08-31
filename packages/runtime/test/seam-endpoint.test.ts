import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ENFORCEMENT_MODE, SEAM_KIND, type Seam } from '@memnox/core';
import { buildServer, type MemnoxServer } from '../src/server';

describe('a seam declares itself', () => {
  let dataDir: string;
  let server: MemnoxServer;
  let token: string;
  let agentId: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-seams-'));
    server = await buildServer({ dataDir });
    const registration = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { name: 'claude-code', kind: 'claude-code' },
    });
    const body = registration.json() as { agent: { id: string }; token: string };
    token = body.token;
    agentId = body.agent.id;
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const declare = (payload: Record<string, unknown>, bearer: string | null = token) =>
    server.app.inject({
      method: 'POST',
      url: '/v1/seams',
      ...(bearer === null ? {} : { headers: { authorization: `Bearer ${bearer}` } }),
      payload,
    });

  const hook = {
    kind: SEAM_KIND.HOOK,
    mode: ENFORCEMENT_MODE.ENFORCE,
    covers: ['filesystem.read', 'shell.execute'],
    blindTo: ["the model's reasoning"],
  };

  it('registers against the agent the token names, not the body', async () => {
    const response = await declare(hook);
    expect(response.statusCode).toBe(201);

    const seam = response.json() as Seam;
    expect(seam.agentId).toBe(agentId);
    expect(seam.kind).toBe(SEAM_KIND.HOOK);
    expect(seam.lastSeenAt).toBeDefined();
  });

  it('shows up in the seam list', async () => {
    await declare(hook);
    const listed = (
      await server.app.inject({ method: 'GET', url: '/v1/seams' })
    ).json() as Seam[];

    expect(listed).toHaveLength(1);
    expect(listed[0]?.covers).toEqual(['filesystem.read', 'shell.execute']);
  });

  /** The reason this route exists: coverage reported an ungoverned machine. */
  it('makes coverage count it, and carries its blind spots', async () => {
    await declare(hook);
    const coverage = (
      await server.app.inject({ method: 'GET', url: '/v1/coverage' })
    ).json() as { seamsCovered: number; seamsTotal: number; blindTo: string[] };

    expect(coverage.seamsTotal).toBe(1);
    expect(coverage.seamsCovered).toBe(1);
    expect(coverage.blindTo).toContain("the model's reasoning");
  });

  it('counts two seams on one agent separately', async () => {
    await declare(hook);
    await declare({ ...hook, kind: SEAM_KIND.MCP_PROXY, covers: ['mcp.*'] });

    const listed = (
      await server.app.inject({ method: 'GET', url: '/v1/seams' })
    ).json() as Seam[];
    expect(listed).toHaveLength(2);
  });

  it('is a heartbeat: declaring twice updates one row', async () => {
    await declare(hook);
    await declare(hook);

    const listed = (
      await server.app.inject({ method: 'GET', url: '/v1/seams' })
    ).json() as Seam[];
    expect(listed).toHaveLength(1);
  });

  it('refuses an unknown token rather than registering an unattributable seam', async () => {
    expect((await declare(hook, 'mnx_nonsense')).statusCode).toBe(401);
    expect((await declare(hook, null)).statusCode).toBe(401);
  });

  it('refuses a seam kind nobody implements', async () => {
    const response = await declare({ ...hook, kind: 'everything' });
    expect(response.statusCode).toBe(400);
  });

  it('refuses covers that are not action globs', async () => {
    expect((await declare({ ...hook, covers: 'mcp.*' })).statusCode).toBe(400);
    expect((await declare({ ...hook, blindTo: [''] })).statusCode).toBe(400);
    expect((await declare({ ...hook, mode: 'sometimes' })).statusCode).toBe(400);
  });

  it('removing a seam removes its claim to coverage', async () => {
    const seam = (await declare(hook)).json() as Seam;

    const removed = await server.app.inject({
      method: 'DELETE',
      url: `/v1/seams/${seam.id}`,
    });
    expect(removed.statusCode).toBe(204);

    const coverage = (
      await server.app.inject({ method: 'GET', url: '/v1/coverage' })
    ).json() as { seamsTotal: number };
    expect(coverage.seamsTotal).toBe(0);
  });

  it('reports a seam that was never there as absent, not as removed', async () => {
    const response = await server.app.inject({
      method: 'DELETE',
      url: '/v1/seams/seam_nope',
    });
    expect(response.statusCode).toBe(404);
  });
});
