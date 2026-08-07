import { describe, expect, it } from 'vitest';
import type { HttpTransport } from '@memnox/sdk';
import { CloudApiError, CloudClient } from '../src/cloud-client';
import type { ResolvedCloud } from '../src/cloud-connection';

const CONNECTION: ResolvedCloud = {
  url: 'https://cloud.acme.test',
  token: 'mnc_token',
  workspace: 'orbit',
  tokenSource: 'config',
};

interface Call {
  url: string;
  authorization?: string;
}

function transportFor(
  status: number,
  body: unknown,
  calls: Call[] = [],
): { transport: HttpTransport; calls: Call[] } {
  const transport: HttpTransport = async (url, init) => {
    calls.push({ url, authorization: init.headers['authorization'] });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { transport, calls };
}

describe('CloudClient', () => {
  it('presents the credential as a bearer token', async () => {
    const { transport, calls } = transportFor(200, { name: 'ana', role: 'reviewer' });

    await new CloudClient(CONNECTION, transport).me();

    expect(calls[0]?.authorization).toBe('Bearer mnc_token');
    expect(calls[0]?.url).toBe('https://cloud.acme.test/v1/me');
  });

  it('reads the review queue for a workspace', async () => {
    const { transport, calls } = transportFor(200, [
      { id: 's1', title: 'Finance owns billing', status: 'pending' },
    ]);

    const pending = await new CloudClient(CONNECTION, transport).suggestions('orbit');

    expect(pending).toHaveLength(1);
    expect(calls[0]?.url).toContain('/v1/workspaces/orbit/suggestions');
  });

  it('accepts either the bare array or a wrapped body', async () => {
    const { transport } = transportFor(200, {
      suggestions: [{ id: 's1', title: 'x', status: 'pending' }],
    });

    expect(
      await new CloudClient(CONNECTION, transport).suggestions('orbit'),
    ).toHaveLength(1);
  });

  it('escapes a workspace id rather than building a broken path', async () => {
    const { transport, calls } = transportFor(200, { entries: [] });

    await new CloudClient(CONNECTION, transport).timeline('a/b', 5);

    expect(calls[0]?.url).toContain('/v1/workspaces/a%2Fb/timeline');
  });

  it('explains a rejected credential instead of surfacing a bare 401', async () => {
    const { transport } = transportFor(401, 'unauthorized');

    await expect(new CloudClient(CONNECTION, transport).me()).rejects.toThrow(
      /memnox login/,
    );
  });

  it('says a 502 means the workspace runtime is down, not the control plane', async () => {
    const { transport } = transportFor(502, 'the workspace runtime is unreachable');

    // Reading this as "the cloud is broken" sends someone debugging the wrong system.
    await expect(
      new CloudClient(CONNECTION, transport).suggestions('orbit'),
    ).rejects.toThrow(/could not reach that workspace's runtime/);
  });

  it('carries the status on the error so a caller can branch on it', async () => {
    const { transport } = transportFor(404, 'no such workspace');

    const failure = await new CloudClient(CONNECTION, transport)
      .timeline('nope', 5)
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(CloudApiError);
    expect((failure as CloudApiError).status).toBe(404);
  });
});
