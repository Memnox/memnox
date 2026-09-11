import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readAccount, writeAccount, accountPathFor } from '@memnox/core';
import {
  applyBundle,
  documentFrom,
  orgConditionsPath,
  orgPolicyPath,
  overlaysFrom,
  PULL_OUTCOME,
  type Bundle,
} from '../src/sync/bundle';
import {
  ORG_CONDITION_GRACE_MS,
  overlaysInForce,
  readOverlays,
  stateFactsInForce,
  WORKSPACE_WIDE,
  writeOverlays,
} from '@memnox/core';
import { accountFrom, approvalUrl, machineKeypair } from '../src/sync/enrol';
import { callCloud, insecureBaseUrl } from '../src/sync/client';
import { connectMachine } from '../src/sync/connect';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { Flow } from '../src/flow';
import { plainStyle } from '../src/style';

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
        { baseUrl: 'https://api.example' },
        keys,
        { machineId: 'mch_1', token: 'mch_secret', mode: 'observe', workspaceId: 'ws_1' },
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
        { baseUrl: 'https://api.example' },
        machineKeypair(),
        { machineId: 'mch_1', token: 't', mode: 'observe', workspaceId: 'ws_1' },
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
        conditions: [
          { id: 'inc_1', kind: 'incident', subject: 'payments', fromAt: 0, untilAt: 1 },
        ],
      }),
    );

    const org = JSON.parse(await readFile(orgConditionsPath(home), 'utf8')) as {
      conditions: unknown[];
    };

    expect(org.conditions).toHaveLength(1);
    expect(orgConditionsPath(home)).not.toBe(join(home, '.memnox', 'overlays.json'));
  });

  /* The two halves were written against each other's documentation rather than
     against each other: this side read `from` and `until`, the wire sends `fromAt`
     and `untilAt`, so every condition arrived windowless and was given a default
     day. A freeze declared for an hour ran for a day, one declared for a week was
     gone after a day, and neither was visible from either repository alone. */
  it('honours the window the control plane sent, rather than defaulting one', () => {
    const hour = 60 * 60 * 1000;
    const overlays = overlaysFrom(
      bundle({
        conditions: [
          { id: 'c1', kind: 'freeze', subject: 'deploys', fromAt: 0, untilAt: hour },
        ],
      }),
      hour * 100,
    );

    expect(overlays[0]?.declaredAt).toBe(new Date(0).toISOString());
    expect(overlays[0]?.validUntil).toBe(new Date(hour).toISOString());
  });

  it('bounds an open-ended condition from the last sync, so it can be renewed', () => {
    const at = 1_000_000;
    const overlays = overlaysFrom(
      bundle({
        conditions: [{ id: 'c1', kind: 'freeze', subject: 'deploys', fromAt: 0 }],
      }),
      at,
    );

    expect(Date.parse(overlays[0]?.validUntil ?? '')).toBe(at + ORG_CONDITION_GRACE_MS);
    expect(overlays[0]?.source).toBe('the workspace');
  });

  it('reads a condition with no subject as the whole workspace', () => {
    const overlays = overlaysFrom(
      bundle({ conditions: [{ id: 'c1', kind: 'freeze', fromAt: 0 }] }),
    );

    expect(overlays[0]?.subject).toBe(WORKSPACE_WIDE);
  });

  /* The file was written, reported as applied, and read by nothing: every gate
     called `readOverlays`, which only ever looked at the local freeze file. A
     production freeze reached every laptop and governed none of them. */
  it('puts a workspace condition where the gate reads it', async () => {
    const soon = Date.now() + 60 * 60 * 1000;
    await applyBundle(
      home,
      bundle({
        conditions: [
          { id: 'c1', kind: 'freeze', subject: 'deploys', fromAt: 0, untilAt: soon },
        ],
      }),
    );

    const facts = stateFactsInForce(
      await overlaysInForce(home),
      new Date().toISOString(),
    );

    expect(facts).toContain('freeze:deploys');
  });

  it('leaves a workspace condition alone when the local freeze file is lifted', async () => {
    const soon = Date.now() + 60 * 60 * 1000;
    await applyBundle(
      home,
      bundle({
        conditions: [
          { id: 'c1', kind: 'freeze', subject: 'deploys', fromAt: 0, untilAt: soon },
        ],
      }),
    );
    // What `freeze --lift` does: read the local file, lift everything, write it back.
    const local = await readOverlays(home);
    await writeOverlays(
      home,
      local.map((each) => ({ ...each, liftedAt: new Date().toISOString() })),
    );

    const facts = stateFactsInForce(
      await overlaysInForce(home),
      new Date().toISOString(),
    );

    expect(facts).toContain('freeze:deploys');
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
  /* The base URL is an API that serves no pages, and on every deployment with a
     console the two are different origins, so the control plane's own answer is
     the only one that can be right. Deriving it here sent people to a 404. */
  it('points at the page the control plane named', () => {
    expect(
      approvalUrl('https://api.memnox.com', 'CDFG-HJKM', {
        verificationUri: 'https://app.memnox.com/device',
        verificationUriComplete: 'https://app.memnox.com/device?code=CDFG-HJKM',
      }),
    ).toBe('https://app.memnox.com/device?code=CDFG-HJKM');
  });

  it('takes the bare page when that is all it was given', () => {
    expect(
      approvalUrl('https://api.memnox.com', 'CDFG-HJKM', {
        verificationUri: 'https://app.memnox.com/device',
      }),
    ).toBe('https://app.memnox.com/device');
  });

  /* A control plane too old to say. Wrong in the same way it always was, and
     not a regression — and right where the console shares the API's origin. */
  it('falls back to the API base when the control plane says nothing', () => {
    expect(approvalUrl('https://api.memnox.com', 'CDFG-HJKM')).toBe(
      'https://api.memnox.com/device?code=CDFG-HJKM',
    );
    expect(approvalUrl('https://api.memnox.com', 'CDFG-HJKM', {})).toBe(
      'https://api.memnox.com/device?code=CDFG-HJKM',
    );
  });
});

describe('the transport refuses to downgrade', () => {
  /* Every call carries the machine's bearer token, and the bundle it pulls back
     carries no signature of its own, so TLS is the only thing authenticating
     either direction. Over http the token is readable by anything on the path
     and the rules are whatever that thing chose to return. */
  it('refuses a control plane that is not https', () => {
    expect(insecureBaseUrl('http://api.example.com')).toContain('not https');
    expect(insecureBaseUrl('http://10.0.0.5:8080')).toContain('not https');
  });

  it('allows https, which is the only thing it allows off this machine', () => {
    expect(insecureBaseUrl('https://api.memnox.com')).toBeNull();
  });

  // Somebody developing against a control plane on their own machine is not a risk.
  it('allows loopback over http, so a local control plane still works', () => {
    expect(insecureBaseUrl('http://localhost:3000')).toBeNull();
    expect(insecureBaseUrl('http://127.0.0.1:3000')).toBeNull();
  });

  it('refuses something that is not a URL at all', () => {
    expect(insecureBaseUrl('api.memnox.com')).toContain('not a URL');
  });

  /* The check is in the transport rather than in `login`, because a hand-edited
     account.json reaches the transport too. */
  it('stops the call rather than only the login', async () => {
    await expect(
      callCloud({ baseUrl: 'http://api.example.com', path: '/v1/x', token: 'secret' }),
    ).rejects.toThrow(/not https/);
  });
});

describe('the browser is the approval step', () => {
  let home: string;

  const BASE = 'https://cloud.memnox.test';
  const CODE = 'CDFG-HJKM';
  const PAGE = `https://app.memnox.test/device?code=${CODE}`;

  /** A control plane that hands out a code and has already been approved. */
  const cloud = (told: boolean) =>
    ((url: URL | string) => {
      const at = String(url);
      const body = at.endsWith('/v1/device/codes')
        ? {
            deviceCode: 'dev-1',
            userCode: CODE,
            intervalSeconds: 0,
            expiresAt: Date.now() + 60_000,
            ...(told
              ? {
                  verificationUri: 'https://app.memnox.test/device',
                  verificationUriComplete: PAGE,
                }
              : {}),
          }
        : {
            machineId: 'mch_1',
            token: 'machine-token',
            mode: 'observe',
            workspaceId: 'acme',
          };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch;

  async function login(
    opens: boolean | null,
    told = true,
  ): Promise<{ out: RecordedOutput; asked: string[] }> {
    vi.stubGlobal('fetch', cloud(told));
    const out = new RecordedOutput();
    const asked: string[] = [];
    await connectMachine(
      new CliContext(out, plainStyle),
      home,
      { url: BASE, ...(opens === null ? { open: false } : {}) },
      new Flow(out, plainStyle),
      {
        open: (url: string) => {
          asked.push(url);
          return opens === true;
        },
      },
    );
    return { out, asked };
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'memnox-approve-'));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(home, { recursive: true, force: true });
  });

  /* The point of the whole change: the link carries the code, so a person who
     got a browser has nothing to read off this screen and type into that one. */
  it('opens the page the control plane named and shows no code', async () => {
    const { out, asked } = await login(true);

    expect(asked).toEqual([PAGE]);
    expect(out.notes.join('\n')).toContain(PAGE);
    /* Not `not.toContain(CODE)`: the link carries it, and that is the point.
       What must not be there is the code asked for on a line of its own. */
    expect(out.notes).not.toContain('Your code');
  });

  /* A container, a CI runner, a server over SSH. Nothing opened, so the eight
     characters are the only way anybody approves this. */
  it('falls back to the code when no browser could be opened', async () => {
    const { out } = await login(false);

    expect(out.notes).toContain('Your code');
    expect(out.notes).toContain(CODE);
  });

  /* A control plane with no console configured sends no page, so the address
     above is this CLI's guess and the code still has to be typed somewhere. */
  it('shows the code when the address carries none', async () => {
    const { out } = await login(true, false);

    expect(out.notes).toContain('Your code');
  });

  it('opens nothing under --no-open, and says the code instead', async () => {
    const { out, asked } = await login(null);

    expect(asked).toEqual([]);
    expect(out.notes).toContain('Your code');
  });
});
