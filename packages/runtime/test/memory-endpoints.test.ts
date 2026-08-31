import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DECISION_ENFORCEMENT, DECISION_STATUS } from '@memnox/memory';
import { buildServer, type MemnoxServer } from '../src/server';

const DECISIONS_URL = '/v1/memory/decisions';

const VALID = {
  title: 'No direct production migrations',
  statement: 'Migrations run through the release pipeline.',
  owner: 'platform-team',
  actions: ['database.migrate'],
  environments: ['production'],
};

let dataDir: string;
let server: MemnoxServer;

async function record(
  payload: Record<string, unknown> = VALID,
): Promise<{ status: number; body: { id?: string; error?: string } }> {
  const response = await server.app.inject({
    method: 'POST',
    url: DECISIONS_URL,
    payload,
  });
  return {
    status: response.statusCode,
    body: response.json() as { id?: string; error?: string },
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'memnox-memory-'));
  server = await buildServer({ dataDir });
});

afterEach(async () => {
  await server.app.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('POST /v1/memory/decisions', () => {
  it('creates a decision and returns 201 with the stored record', async () => {
    const { status, body } = await record();

    expect(status).toBe(201);
    expect(body.id).toBeDefined();
  });

  it('400s when title, statement, or owner is missing', async () => {
    for (const field of ['title', 'statement', 'owner']) {
      const payload = { ...VALID } as Record<string, unknown>;
      delete payload[field];

      const { status, body } = await record(payload);

      expect(status).toBe(400);
      expect(body.error).toContain('are required');
    }
  });

  it('400s when actions is missing, not an array, or empty', async () => {
    for (const actions of [undefined, 'database.migrate', []]) {
      const { status, body } = await record({ ...VALID, actions });

      expect(status).toBe(400);
      expect(body.error).toContain('non-empty pattern array');
    }
  });

  it('409s on an equivalent active decision rather than duplicating it', async () => {
    await record();

    const { status, body } = await record();

    expect(status).toBe(409);
    expect(body.error).toContain('already exists');
  });

  it('404s when the decision it claims to supersede does not exist', async () => {
    const { status, body } = await record({ ...VALID, supersedes: 'dec_missing' });

    expect(status).toBe(404);
    expect(body.error).toContain('supersede');
  });

  it('coerces an unrecognised enforcement to require_approval', async () => {
    await record({ ...VALID, enforcement: 'allow-everything' });

    const list = await server.app.inject({ method: 'GET', url: DECISIONS_URL });
    const decisions = list.json() as Array<{ enforcement: string }>;
    expect(decisions[0]?.enforcement).toBe(DECISION_ENFORCEMENT.ESCALATE);
  });
});

describe('GET /v1/memory/decisions', () => {
  it('returns an empty corpus rather than 404', async () => {
    const response = await server.app.inject({ method: 'GET', url: DECISIONS_URL });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it('lists what was recorded', async () => {
    await record();

    const response = await server.app.inject({ method: 'GET', url: DECISIONS_URL });

    expect((response.json() as unknown[]).length).toBe(1);
  });
});

describe('POST /v1/memory/decisions/:id/status', () => {
  it('retires a decision', async () => {
    const { body } = await record();

    const response = await server.app.inject({
      method: 'POST',
      url: `${DECISIONS_URL}/${body.id}/status`,
      payload: { status: DECISION_STATUS.RETIRED },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { status: string }).status).toBe(DECISION_STATUS.RETIRED);
  });

  it('400s on a status outside the allowed set', async () => {
    const { body } = await record();

    const response = await server.app.inject({
      method: 'POST',
      url: `${DECISIONS_URL}/${body.id}/status`,
      payload: { status: 'sleeping' },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toContain('must be one of');
  });

  it('400s when no status is given at all', async () => {
    const { body } = await record();

    const response = await server.app.inject({
      method: 'POST',
      url: `${DECISIONS_URL}/${body.id}/status`,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  it('404s for a decision that does not exist', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: `${DECISIONS_URL}/dec_missing/status`,
      payload: { status: DECISION_STATUS.RETIRED },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('GET /v1/memory/decisions/search', () => {
  it('finds a decision by keyword', async () => {
    await record();

    const response = await server.app.inject({
      method: 'GET',
      url: `${DECISIONS_URL}/search?q=migrations`,
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as unknown[]).length).toBeGreaterThan(0);
  });

  it('400s when the query string is missing', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: `${DECISIONS_URL}/search`,
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toContain('"q" is required');
  });
});

describe('POST /v1/memory/search', () => {
  it('falls back to keyword search when no embedding key is configured', async () => {
    await record();

    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/memory/search',
      payload: { query: 'migrations' },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as unknown[]).length).toBeGreaterThan(0);
  });

  it('400s when the body carries no query', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/memory/search',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toContain('"query" is required');
  });
});

describe('GET /v1/memory/digest and /health', () => {
  it('renders a digest containing the recorded decision', async () => {
    await record();

    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/memory/digest',
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { digest: string }).digest).toContain(VALID.title);
  });

  it('reports corpus health', async () => {
    await record();

    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/memory/health',
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { activeDecisions: number }).activeDecisions).toBe(1);
  });
});

describe('DELETE /v1/memory/decisions/:id', () => {
  it('removes a decision', async () => {
    const { body } = await record();

    const response = await server.app.inject({
      method: 'DELETE',
      url: `${DECISIONS_URL}/${body.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ removed: true });
  });

  it('404s when the decision is not there', async () => {
    const response = await server.app.inject({
      method: 'DELETE',
      url: `${DECISIONS_URL}/dec_missing`,
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('memory endpoints — authorization', () => {
  it('requires admin for writes and viewer for reads when a token is configured', async () => {
    const secured = await buildServer({ dataDir, adminToken: 'admin-secret' });
    try {
      const anonymousWrite = await secured.app.inject({
        method: 'POST',
        url: DECISIONS_URL,
        payload: VALID,
      });
      expect(anonymousWrite.statusCode).toBe(401);

      const anonymousRead = await secured.app.inject({
        method: 'GET',
        url: DECISIONS_URL,
      });
      expect(anonymousRead.statusCode).toBe(401);

      const authorized = await secured.app.inject({
        method: 'POST',
        url: DECISIONS_URL,
        headers: { authorization: 'Bearer admin-secret' },
        payload: VALID,
      });
      expect(authorized.statusCode).toBe(201);
    } finally {
      await secured.app.close();
    }
  });
});
