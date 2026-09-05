import { describe, expect, it } from 'vitest';
import {
  authenticatedClis,
  findCredentials,
  productionLooking,
  readEnvFile,
} from '../src/discovery/credentials';
import type { MachineReader } from '../src/discovery/ports';

const HOME = '/home/dev';

/** Real shapes, with real-looking secrets in them, so the leak test means something. */
const AWS_SECRET = ['wJalrXUtnFEMI', 'K7MDENGbPxRfiCYEXAMPLEKEY'].join('');
const FILES: Record<string, string> = {
  [`${HOME}/.aws/credentials`]: `[default]\naws_access_key_id = ${['AKIA', 'IOSFODNN7EXAMPLE'].join('')}\naws_secret_access_key = ${AWS_SECRET}\n\n[production]\naws_access_key_id = ${['AKIA', 'IOSFODNN7PROD123'].join('')}\n`,
  [`${HOME}/.config/gh/hosts.yml`]:
    'github.com:\n    user: someone\n    oauth_token: gho_supersecrettoken\n',
  [`${HOME}/.kube/config`]: 'contexts:\n- name: docker-desktop\n- name: prod-eu-1\n',
  [`${HOME}/.docker/config.json`]:
    '{"auths":{"ghcr.io":{"auth":"c2VjcmV0"},"docker.io":{}}}',
  [`${HOME}/.ssh/id_ed25519`]: '-----BEGIN OPENSSH PRIVATE KEY-----\nbase64secret\n',
  [`${HOME}/.vercel/auth.json`]: '{"token":"vercel_live_secret"}',
};

const reader: MachineReader = {
  exists: async (path) => FILES[path] !== undefined,
  read: async (path) => FILES[path] ?? null,
  list: async () => [],
  homeDir: () => HOME,
  userName: () => 'dev',
};

describe('finding credentials', () => {
  it('names each one in the reader’s words', async () => {
    const kinds = (await findCredentials(reader)).map((each) => each.kind);
    expect(kinds).toContain('AWS');
    expect(kinds).toContain('GitHub CLI');
    expect(kinds).toContain('Kubernetes');
    expect(kinds).toContain('SSH key');
    expect(kinds).toContain('Vercel');
  });

  it('reads structure — profiles, hosts, contexts — and never a value', async () => {
    const found = await findCredentials(reader);
    const aws = found.find((each) => each.kind === 'AWS');
    expect(aws?.detail).toBe('profiles: default, production');
    expect(found.find((e) => e.kind === 'Kubernetes')?.detail).toContain('prod-eu-1');
    expect(found.find((e) => e.kind === 'GitHub CLI')?.detail).toBe('github.com');
    expect(found.find((e) => e.kind === 'Docker registries')?.detail).toContain(
      'ghcr.io',
    );
  });

  it('never lets a secret value into the report — the one that must not fail', async () => {
    const serialized = JSON.stringify(await findCredentials(reader));
    for (const secret of [
      AWS_SECRET,
      'gho_supersecrettoken',
      'vercel_live_secret',
      'base64secret',
      'c2VjcmV0',
      'BEGIN OPENSSH',
    ]) {
      expect(serialized, `leaked ${secret}`).not.toContain(secret);
    }
  });

  it('counts what it found, so a summary needs no second read', async () => {
    const aws = (await findCredentials(reader)).find((each) => each.kind === 'AWS');
    expect(aws?.count).toBe(2);
  });

  it('survives a config it cannot parse, still naming it as present', async () => {
    const broken: MachineReader = {
      ...reader,
      read: async (p) => (p.endsWith('config.json') ? '{ not json' : (FILES[p] ?? null)),
    };
    const docker = (await findCredentials(broken)).find(
      (each) => each.kind === 'Docker registries',
    );
    expect(docker).toBeDefined();
    expect(docker?.detail).toBeUndefined();
  });
});

describe('.env files', () => {
  it('counts variables and the ones named like a key', () => {
    const found = readEnvFile(
      '.env',
      [
        'DATABASE_URL=postgres://user:hunter2@db/app',
        'STRIPE_SECRET_KEY=sk_live_abc',
        'API_TOKEN=xyz',
        'PORT=3000',
        '# a comment',
        '',
        'DEBUG=true',
      ].join('\n'),
    );

    expect(found.variables).toBe(5);
    /* DATABASE_URL, STRIPE_SECRET_KEY and API_TOKEN. The first ends in `_URL`, which
       no suffix rule would catch, and it carries a password in the middle of it. */
    expect(found.keyLike).toBe(3);
  });

  it('catches a credential whose name no suffix rule would match', () => {
    expect(readEnvFile('.env', 'DATABASE_URL=postgres://u:pw@h/db\n').keyLike).toBe(1);
    expect(readEnvFile('.env', 'API_URL=https://api.example\n').keyLike).toBe(0);
  });

  it('reads names only, so no value can reach the report', () => {
    const found = readEnvFile('.env', 'STRIPE_SECRET_KEY=sk_live_abc\n');
    expect(JSON.stringify(found)).not.toContain('sk_live_abc');
  });
});

describe('authenticated CLIs', () => {
  it('pairs a binary with the credential that makes it authenticated', async () => {
    const credentials = await findCredentials(reader);
    const clis = authenticatedClis(['aws', 'gh', 'kubectl', 'vercel'], credentials);

    expect(clis.map((each) => each.name).sort()).toEqual([
      'aws',
      'gh',
      'kubectl',
      'vercel',
    ]);
    expect(clis.find((each) => each.name === 'aws')?.headline).toContain(
      'infrastructure',
    );
    expect(clis.find((each) => each.name === 'gh')?.headline).toContain('merge');
  });

  it('ignores a binary with no credential, and a credential with no binary', async () => {
    const credentials = await findCredentials(reader);
    expect(authenticatedClis(['terraform'], credentials)).toEqual([]);
    expect(authenticatedClis(['ls', 'cat'], credentials)).toEqual([]);
  });

  it('counts the verbs that change the world, from the same table enforcement reads', async () => {
    const [aws] = authenticatedClis(['aws'], await findCredentials(reader));
    expect(aws?.externalStateVerbs).toBeGreaterThan(0);
    expect(aws?.destructiveVerbs).toBeGreaterThan(0);
  });

  it('takes a credential from an environment variable too', () => {
    const [gh] = authenticatedClis(['gh'], [], ['GH_TOKEN']);
    expect(gh?.via).toBe('GH_TOKEN');
  });

  it('says a name looks like production rather than asserting that it is', async () => {
    const clis = authenticatedClis(['aws', 'kubectl'], await findCredentials(reader));
    expect(clis.find((each) => each.name === 'aws')?.productionLooking).toBe(
      'production',
    );
    expect(clis.find((each) => each.name === 'kubectl')?.productionLooking).toBe(
      'prod-eu-1',
    );
    expect(productionLooking('contexts: docker-desktop')).toBeUndefined();
  });
});
