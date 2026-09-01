import { describe, expect, it } from 'vitest';
import { databasesIn, detectTools, networkReach } from '../src/reach-detail';
import { spellingsOf } from '../src/doctor';
import { RESOURCE_KIND, SENSITIVITY } from '../src/discovery.constants';
import type { MachineReader } from '../src/ports';
import type { Surface } from '../src/surface';

class FakeMachine implements MachineReader {
  constructor(private readonly present: readonly string[]) {}
  async exists(path: string): Promise<boolean> {
    return this.present.includes(path);
  }
  async read(): Promise<string | null> {
    return null;
  }
  async list(): Promise<string[]> {
    return [];
  }
  homeDir(): string {
    return '/home/dev';
  }
  userName(): string {
    return 'dev';
  }
}

/** Assembled at runtime: a connection string never appears as a literal here. */
const PROD_URL = ['postgres://user', 'hunter2@prod-db.internal:5432/app'].join(':');
const LOCAL_URL = ['postgres://dev', 'dev@localhost:5432/app'].join(':');

describe('detectTools', () => {
  it('names a tool by the path that proved it', async () => {
    const tools = await detectTools(
      new FakeMachine(['/usr/bin/git', '/opt/homebrew/bin/kubectl']),
    );
    expect(tools).toEqual([
      { name: 'git', detectedFrom: '/usr/bin/git' },
      { name: 'kubectl', detectedFrom: '/opt/homebrew/bin/kubectl' },
    ]);
  });

  it('counts a tool once, however many places it could live', async () => {
    const tools = await detectTools(
      new FakeMachine(['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git']),
    );
    expect(tools.filter((tool) => tool.name === 'git')).toHaveLength(1);
  });

  it('claims nothing on a machine that has none of them', async () => {
    expect(await detectTools(new FakeMachine([]))).toEqual([]);
  });
});

describe('databasesIn', () => {
  it('names the scheme and that it reads as production', () => {
    const found = databasesIn(`DATABASE_URL=${PROD_URL}`, '/srv/app/.env');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      kind: RESOURCE_KIND.DB,
      path: 'postgres production URL',
      declaredIn: '/srv/app/.env',
      sensitivity: SENSITIVITY.CRITICAL,
    });
  });

  /** The URL holds a credential; the value never leaves the process that read it. */
  it('keeps the scheme and never the URL', () => {
    const written = JSON.stringify(databasesIn(`X=${PROD_URL}`, '/srv/.env'));
    expect(written).not.toContain('hunter2');
    expect(written).not.toContain('prod-db.internal');
    expect(written).not.toContain('postgres://');
  });

  it('does not call a local database production', () => {
    const found = databasesIn(`DATABASE_URL=${LOCAL_URL}`, '/srv/.env');
    expect(found[0]?.path).toBe('postgres URL');
    expect(found[0]?.sensitivity).toBe(SENSITIVITY.SENSITIVE);
  });

  it('names one database once, however many times it is written', () => {
    const found = databasesIn(`A=${PROD_URL}\nB=${PROD_URL}`, '/srv/.env');
    expect(found).toHaveLength(1);
  });

  it('says nothing about a file with no connection string', () => {
    expect(databasesIn('NODE_ENV=production\nPORT=3000', '/srv/.env')).toEqual([]);
  });
});

const surfaceOf = (kind: Surface['kind']): Surface => ({
  agentId: 'agt_1',
  kind,
  detectedFrom: '/home/dev/.claude.json',
});

describe('networkReach', () => {
  it('is reachable once an agent can run a shell', () => {
    const network = networkReach([surfaceOf('shell')]);
    expect(network).toMatchObject({
      kind: RESOURCE_KIND.NETWORK,
      path: 'network',
      declaredIn: 'unrestricted',
    });
  });

  it('is reachable through a network surface too', () => {
    expect(networkReach([surfaceOf('network')])).not.toBeNull();
  });

  /** Derived from the surfaces found, never asserted on its own. */
  it('claims nothing when no surface reaches it', () => {
    expect(networkReach([surfaceOf('filesystem')])).toBeNull();
    expect(networkReach([])).toBeNull();
  });
});

/** A rule naming one spelling of a file is one the other spelling walks past. */
describe('spellingsOf', () => {
  it('names both spellings of a path behind a symlinked root', () => {
    expect(spellingsOf('/private/tmp/app/.env')).toEqual([
      '/private/tmp/app/.env',
      '/tmp/app/.env',
    ]);
    expect(spellingsOf('/tmp/app/.env')).toEqual([
      '/tmp/app/.env',
      '/private/tmp/app/.env',
    ]);
  });

  it('leaves an ordinary path as its single name', () => {
    expect(spellingsOf('/home/dev/.aws/credentials')).toEqual([
      '/home/dev/.aws/credentials',
    ]);
  });
});
