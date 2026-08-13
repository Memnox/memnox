import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '../src/agent-config';
import {
  CLOUD_NOT_CONFIGURED,
  ENV_CLOUD_TOKEN,
  ENV_CLOUD_URL,
  ENV_CLOUD_WORKSPACE,
  isNotConfigured,
  resolveCloud,
} from '../src/cloud-connection';

const STORED: AgentConfig = {
  token: 'mnx_agent',
  url: 'http://127.0.0.1:7466',
  cloud: { url: 'https://cloud.acme.test', token: 'mnc_stored', workspace: 'orbit' },
};

describe('resolveCloud', () => {
  it('uses what memnox login stored', () => {
    const resolved = resolveCloud({}, STORED, {});

    expect(isNotConfigured(resolved)).toBe(false);
    if (isNotConfigured(resolved)) return;
    expect(resolved.url).toBe('https://cloud.acme.test');
    expect(resolved.token).toBe('mnc_stored');
    expect(resolved.workspace).toBe('orbit');
    expect(resolved.tokenSource).toBe('config');
  });

  it('lets the environment win, so CI presents its own identity', () => {
    const resolved = resolveCloud({}, STORED, {
      [ENV_CLOUD_TOKEN]: 'mnc_ci',
      [ENV_CLOUD_URL]: 'https://ci.acme.test',
      [ENV_CLOUD_WORKSPACE]: 'payments',
    });

    if (isNotConfigured(resolved)) throw new Error('expected a resolution');
    expect(resolved.token).toBe('mnc_ci');
    expect(resolved.url).toBe('https://ci.acme.test');
    expect(resolved.workspace).toBe('payments');
    expect(resolved.tokenSource).toBe('environment');
  });

  it('lets an explicit flag beat both', () => {
    const resolved = resolveCloud(
      { cloudToken: 'mnc_flag', workspace: 'flagged' },
      STORED,
      { [ENV_CLOUD_TOKEN]: 'mnc_ci' },
    );

    if (isNotConfigured(resolved)) throw new Error('expected a resolution');
    expect(resolved.token).toBe('mnc_flag');
    expect(resolved.workspace).toBe('flagged');
    expect(resolved.tokenSource).toBe('flag');
  });

  it('reports not configured rather than half a credential', () => {
    // A URL with no token would fail later as an unauthorized nobody can explain.
    expect(resolveCloud({ cloudUrl: 'https://cloud.acme.test' }, {}, {})).toBe(
      CLOUD_NOT_CONFIGURED,
    );
    expect(resolveCloud({ cloudToken: 'mnc_x' }, {}, {})).toBe(CLOUD_NOT_CONFIGURED);
    expect(resolveCloud({}, {}, {})).toBe(CLOUD_NOT_CONFIGURED);
  });

  it('resolves without a workspace, since login may not have chosen one', () => {
    const resolved = resolveCloud(
      {},
      { cloud: { url: 'https://cloud.acme.test', token: 'mnc_x' } },
      {},
    );

    if (isNotConfigured(resolved)) throw new Error('expected a resolution');
    expect(resolved.workspace).toBeUndefined();
  });

  it('strips a trailing slash so joined paths do not double the separator', () => {
    const resolved = resolveCloud(
      { cloudUrl: 'https://cloud.acme.test/', cloudToken: 'mnc_x' },
      {},
      {},
    );

    if (isNotConfigured(resolved)) throw new Error('expected a resolution');
    expect(resolved.url).toBe('https://cloud.acme.test');
  });

  it('keeps the org credential separate from the agent token', () => {
    const resolved = resolveCloud({}, STORED, {});

    // A governed agent holds the agent token; it must not thereby read the org.
    if (isNotConfigured(resolved)) throw new Error('expected a resolution');
    expect(resolved.token).not.toBe(STORED.token);
  });
});
