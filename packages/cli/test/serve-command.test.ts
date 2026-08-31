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

const ENV_KEYS = [
  'MEMNOX_ADMIN_TOKEN',
  'MEMNOX_DATABASE_URL',
  'MEMNOX_REDIS_URL',
  'MEMNOX_DATA_KEY',
  'MEMNOX_EMBEDDING_KEY',
];

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

  it('says search is keyword-only until an embedding key is configured', async () => {
    const { launch } = launcher();

    const { out } = await runServe([], launch);

    expect(out.text).toContain('Decision search: keyword only');
  });

  it('reports per-process rate limits until Redis is configured', async () => {
    const { launch } = launcher();

    const { out } = await runServe([], launch);

    expect(out.text).toContain('Rate limits: per-process');
  });

  it('reports shared rate limits once Redis is configured', async () => {
    const { launch } = launcher();

    const { out } = await runServe(['--redis-url', 'redis://localhost'], launch);

    expect(out.text).toContain('Rate limits: shared via Redis');
  });

  it('announces each guard that is enabled', async () => {
    const { launch } = launcher();

    const { out } = await runServe(['--behavior-guard', '--verification-guard'], launch);

    expect(out.text).toContain('Behavior guard: enabled');
    expect(out.text).toContain('Verification guard: enabled');
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

    await runServe(
      ['--port', '9000', '--rate-limit', '120', '--token-budget', '50000'],
      launch,
    );

    expect(launched.overrides.port).toBe(9000);
    expect(launched.overrides.checkRateLimitPerMinute).toBe(120);
    expect(launched.overrides.sessionTokenBudget).toBe(50_000);
  });

  it('leaves optional numeric flags undefined when not passed', async () => {
    const { launch, launched } = launcher();

    await runServe([], launch);

    expect(launched.overrides.checkRateLimitPerMinute).toBeUndefined();
    expect(launched.overrides.auditRetentionDays).toBeUndefined();
  });

  it('falls back to the environment for secrets', async () => {
    process.env['MEMNOX_ADMIN_TOKEN'] = 'from-env';
    process.env['MEMNOX_DATABASE_URL'] = 'postgres://env/db';
    const { launch, launched } = launcher();

    await runServe([], launch);

    expect(launched.overrides.adminToken).toBe('from-env');
    expect(launched.overrides.databaseUrl).toBe('postgres://env/db');
  });

  it('prefers an explicit flag over the environment', async () => {
    process.env['MEMNOX_ADMIN_TOKEN'] = 'from-env';
    const { launch, launched } = launcher();

    await runServe(['--admin-token', 'from-flag'], launch);

    expect(launched.overrides.adminToken).toBe('from-flag');
  });

  it('enables memory by default', async () => {
    const { launch, launched } = launcher();

    await runServe([], launch);

    expect(launched.overrides.memoryEnabled).toBe(true);
  });

  it('honours the --no- forms', async () => {
    const { launch, launched } = launcher();

    await runServe(['--no-memory'], launch);

    expect(launched.overrides.memoryEnabled).toBe(false);
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

describe('memnox serve — semantic search flags', () => {
  const key = ['sk', 'embed', 'flag'].join('-');

  // These once mapped to config without being registered, so semantic search
  // could not be switched on from the CLI at all.
  it('accepts the embedding flags and passes them through', async () => {
    const { launch, launched } = launcher();

    // An unregistered flag makes commander throw, so parsing is asserted here too.
    await runServe(
      [
        '--embedding-key',
        key,
        '--embedding-model',
        'text-embedding-3-large',
        '--embedding-dimensions',
        '3072',
      ],
      launch,
    );

    expect(launched.overrides.embeddingApiKey).toBe(key);
    expect(launched.overrides.embeddingModel).toBe('text-embedding-3-large');
    expect(launched.overrides.embeddingDimensions).toBe(3072);
  });

  it('reads the key from the environment for container deployments', async () => {
    process.env['MEMNOX_EMBEDDING_KEY'] = key;
    const { launch, launched } = launcher();

    await runServe([], launch);

    expect(launched.overrides.embeddingApiKey).toBe(key);
  });

  it('leaves search on keyword only when no key is given', async () => {
    const { launch, launched } = launcher();

    await runServe([], launch);

    expect(launched.overrides.embeddingApiKey).toBeUndefined();
    expect(launched.overrides.embeddingDimensions).toBeUndefined();
  });
});
