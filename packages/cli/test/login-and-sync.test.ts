import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAccount, writeAccount, accountPathFor } from '../src/sync/account';
import {
  applyBundle,
  documentFrom,
  orgConditionsPath,
  orgPolicyPath,
  overlaysFrom,
  PULL_OUTCOME,
  type Bundle,
} from '../src/sync/bundle';
import { accountFrom, approvalUrl, machineKeypair } from '../src/sync/enrol';

const bundle = (over: Partial<Bundle> = {}): Bundle => ({
  hash: 'b1a2c3',
  policies: [],
  rules: [
    {
      id: 'no-force-push-to-main',
      policyHash: 'p1',
      line: 3,
      domain: 'git',
      effect: 'deny',
      specificity: 2,
      match: 'git.push*',
      reason: 'main is shared.',
    },
  ],
  conditions: [],
  tags: [],
  ...over,
});

describe('the account file', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'memnox-login-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  /* The whole of the promise: no file, no network, and every caller reads that
     as "stay local" rather than as an error. */
  it('is absent until somebody logs in', async () => {
    expect(await readAccount(home)).toBeNull();
  });

  it('is owner-only, because anything that reads it can act as this machine', async () => {
    const keys = machineKeypair();
    await writeAccount(
      home,
      accountFrom(
        { baseUrl: 'https://api.example', workspaceId: 'ws_1' },
        keys,
        { machineId: 'mch_1', token: 'mch_secret', mode: 'observe' },
        '2026-09-05T12:00:00.000Z',
      ),
    );

    const mode = (await stat(accountPathFor(home))).mode & 0o777;

    expect(mode).toBe(0o600);
  });

  it('keeps the private key here and nowhere else', async () => {
    const keys = machineKeypair();

    expect(keys.privateKey).toContain('PRIVATE KEY');
    expect(keys.publicKey).toContain('PUBLIC KEY');
    expect(keys.publicKey).not.toContain('PRIVATE');
  });

  // A half-written file is not an account; logging in again replaces it.
  it('reads a corrupt file as not logged in rather than crashing', async () => {
    await writeAccount(
      home,
      accountFrom(
        { baseUrl: 'https://api.example', workspaceId: 'ws_1' },
        machineKeypair(),
        { machineId: 'mch_1', token: 't', mode: 'observe' },
        '2026-09-05T12:00:00.000Z',
      ),
    );
    await writeFile(accountPathFor(home), '{ not json', 'utf8');

    expect(await readAccount(home)).toBeNull();
  });
});

describe('applying a bundle', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'memnox-bundle-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('writes the rules where the gate already looks, and registers them', async () => {
    const result = await applyBundle(home, bundle());

    expect(result.outcome).toBe(PULL_OUTCOME.APPLIED);
    expect(result.rules).toBe(1);
    const registry = JSON.parse(
      await readFile(join(home, '.memnox', 'policies.json'), 'utf8'),
    ) as { files: string[] };
    expect(registry.files).toContain(orgPolicyPath(home));
  });

  /* Whole or not at all. A bundle that half-applies is a rule set nobody wrote:
     some rules from today, some from last week, and no way to say which. */
  it('refuses a bundle that will not load, and keeps the previous one', async () => {
    await applyBundle(home, bundle());
    const before = await readFile(orgPolicyPath(home), 'utf8');

    const broken = bundle({
      hash: 'b2',
      rules: [
        {
          id: 'nonsense',
          policyHash: 'p',
          line: 1,
          domain: 'git',
          effect: 'not-an-effect',
          specificity: 1,
          match: 'git.push',
        },
      ],
    });
    const result = await applyBundle(home, broken);

    expect(result.outcome).toBe(PULL_OUTCOME.REFUSED);
    expect(await readFile(orgPolicyPath(home), 'utf8')).toBe(before);
  });

  // A rejected bundle must not sit next to the one in force looking like a peer.
  it('leaves no half-applied file behind when it refuses one', async () => {
    await applyBundle(home, bundle());
    await applyBundle(
      home,
      bundle({
        hash: 'b2',
        rules: [
          {
            id: 'nonsense',
            policyHash: 'p',
            line: 1,
            domain: 'git',
            effect: 'not-an-effect',
            specificity: 1,
            match: 'git.push',
          },
        ],
      }),
    );

    const left = await readdir(join(home, '.memnox'));

    expect(left.filter((name) => name.endsWith('.incoming'))).toEqual([]);
  });

  // So the next pull can send it as `If-None-Match` and cost one 304.
  it('carries the bundle hash in the file it wrote', async () => {
    await applyBundle(home, bundle());

    const document = JSON.parse(await readFile(orgPolicyPath(home), 'utf8')) as {
      bundleHash: string;
    };

    expect(document.bundleHash).toBe('b1a2c3');
  });

  /* Their own file, not the one `memnox freeze` writes: a local `--lift` reads
     that file, marks everything active as lifted and writes it back, which would
     quietly end an incident somebody declared for the whole company. */
  it('keeps workspace conditions out of the local freeze file', async () => {
    await applyBundle(
      home,
      bundle({
        conditions: [{ id: 'inc_1', kind: 'incident', subject: 'payments', until: 1 }],
      }),
    );

    const org = JSON.parse(await readFile(orgConditionsPath(home), 'utf8')) as unknown[];

    expect(org).toHaveLength(1);
    expect(orgConditionsPath(home)).not.toBe(join(home, '.memnox', 'overlays.json'));
  });

  it('gives every condition an end, like every other overlay', () => {
    const overlays = overlaysFrom(
      bundle({ conditions: [{ id: 'c1', kind: 'freeze', subject: 'deploys' }] }),
    );

    expect(overlays[0]?.validUntil).toBeDefined();
    expect(overlays[0]?.source).toBe('the workspace');
  });

  it('turns a rule into the shape the gate reads', () => {
    const document = documentFrom(bundle()) as {
      policies: { name: string; match: { actions: string[] } }[];
    };

    expect(document.policies[0]?.name).toBe('no-force-push-to-main');
    expect(document.policies[0]?.match.actions).toEqual(['git.push*']);
  });
});

describe('what a person is shown', () => {
  it('points at a page they can open', () => {
    expect(approvalUrl('https://api.memnox.com', 'CDFG-HJKM')).toBe(
      'https://api.memnox.com/device?code=CDFG-HJKM',
    );
  });
});
