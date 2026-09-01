import { afterEach, describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import { DEFAULT_HOST, DEFAULT_PORT, type RuntimeConfig } from '@memnox/runtime';
import { registerServeCommand, type ServerLauncher } from '../src/commands/serve.command';
import { runCommand } from './cli-harness';

const BASE_CONFIG = {
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  auditRetentionDays: 0,
} as unknown as RuntimeConfig;

interface Launched {
  overrides: Partial<RuntimeConfig>;
}

/** Echoes the overrides back as the running config, the way startServer does. */
function launcher(extra: Partial<RuntimeConfig> = {}): {
  launch: ServerLauncher;
  launched: Launched;
} {
  const launched: Launched = { overrides: {} };
  const launch: ServerLauncher = async (overrides) => {
    launched.overrides = overrides;
    return { config: { ...BASE_CONFIG, ...overrides, ...extra } as RuntimeConfig };
  };
  return { launch, launched };
}

async function runServe(
  args: string[],
  launch: ServerLauncher,
): ReturnType<typeof runCommand> {
  return runCommand(
    (program, context) => registerServeCommand(program, context, launch),
    ['serve', ...args],
  );
}

const ENV_KEYS = ['MEMNOX_ADMIN_TOKEN', 'MEMNOX_DATA_KEY'];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('memnox serve — startup banner', () => {
  it('reports the bound address and warns when no policy file is loaded', async () => {
    const { launch } = launcher();

    const { out } = await runServe([], launch);

    expect(out.text).toContain(`listening on http://${DEFAULT_HOST}:${DEFAULT_PORT}`);
    expect(out.text).toContain('No policy file loaded');
    expect(out.text).toContain('memnox init');
  });

  it('names the policy file when one is given', async () => {
    const { launch } = launcher();

    const { out } = await runServe(['--policies', 'memnox.policies.yaml'], launch);

    expect(out.text).toContain('Policies: memnox.policies.yaml');
    expect(out.text).not.toContain('No policy file loaded');
  });

  /* --policies repeats and a registry adds more, so naming only the first left the
     operator reading a banner that disagreed with what was actually in force. */
  it('names every source it loaded, not only the first', async () => {
    const { launch } = launcher();

    const { out } = await runServe(
      [
        '--policies',
        'a.yaml',
        '--policies',
        'b.yaml',
        '--policy-registry',
        '/home/dev/.memnox/policies.json',
      ],
      launch,
    );

    expect(out.text).toContain('a.yaml');
    expect(out.text).toContain('b.yaml');
    expect(out.text).toContain('/home/dev/.memnox/policies.json (registry)');
  });

  it('reports per-process rate limits, because there is only ever one process', async () => {
    const { launch } = launcher();

    const { out } = await runServe([], launch);

    expect(out.text).toContain('Rate limits: per-process');
  });

  it('reports https and mTLS when all three TLS files are given', async () => {
    const { launch } = launcher();

    const { out } = await runServe(
      ['--tls-cert', 'c.pem', '--tls-key', 'k.pem', '--tls-ca', 'ca.pem'],
      launch,
    );

    expect(out.text).toContain('listening on https://');
    expect(out.text).toContain('mTLS: client-certificate agent auth enabled');
  });

  it('reports audit retention only when pruning is enabled', async () => {
    const { launch } = launcher();

    const quiet = await runServe([], launch);
    expect(quiet.out.text).not.toContain('Audit retention');

    const loud = await runServe(['--audit-retention-days', '30'], launch);
    expect(loud.out.text).toContain('Audit retention: 30 days');
  });
});

describe('memnox serve — option mapping', () => {
  it('parses numeric flags into numbers', async () => {
    const { launch, launched } = launcher();

    await runServe(['--port', '9000', '--rate-limit', '120'], launch);

    expect(launched.overrides.port).toBe(9000);
    expect(launched.overrides.checkRateLimitPerMinute).toBe(120);
  });

  it('leaves optional numeric flags undefined when not passed', async () => {
    const { launch, launched } = launcher();

    await runServe([], launch);

    expect(launched.overrides.checkRateLimitPerMinute).toBeUndefined();
    expect(launched.overrides.auditRetentionDays).toBeUndefined();
  });

  it('falls back to the environment for secrets', async () => {
    process.env['MEMNOX_ADMIN_TOKEN'] = 'from-env';
    const { launch, launched } = launcher();

    await runServe([], launch);

    expect(launched.overrides.adminToken).toBe('from-env');
  });

  it('prefers an explicit flag over the environment', async () => {
    process.env['MEMNOX_ADMIN_TOKEN'] = 'from-env';
    const { launch, launched } = launcher();

    await runServe(['--admin-token', 'from-flag'], launch);

    expect(launched.overrides.adminToken).toBe('from-flag');
  });

  it('accepts block as a default effect', async () => {
    const { launch, launched } = launcher();

    await runServe(['--default-effect', DECISION_EFFECT.WITHHOLD], launch);

    expect(launched.overrides.defaultEffect).toBe(DECISION_EFFECT.WITHHOLD);
  });

  it('rejects a default effect that is not allow or block', async () => {
    const { launch } = launcher();

    await expect(
      runServe(['--default-effect', DECISION_EFFECT.ESCALATE], launch),
    ).rejects.toThrow(/--default-effect must be one of/);
  });
});
