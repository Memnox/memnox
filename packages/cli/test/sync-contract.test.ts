import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DECISION_EFFECT,
  ENFORCEMENT_MODE,
  EVENT_SCHEMA_VERSION,
  EVENT_SURFACE,
  isEnforcementMode,
  overlaysInForce,
  stateFactsInForce,
  type EnvironmentSnapshot,
  type MemnoxEvent,
} from '@memnox/core';
const BUNDLE_HASH = '866d2d658ff6e7de76941adf5b6aa1b719cec0a06f791631677207140f6d8389';

import { applyBundle, pullBundle, type Bundle } from '../src/sync/bundle';
import type { Account } from '@memnox/core';
import { censusFrom } from '../src/sync/census';
import { fitting } from '../src/sync/push';

/**
 * This machine's half of `docs/sync-contract.json`.
 *
 * The two repositories were each tested against their own idea of the wire and
 * never against each other's, so a bundle whose conditions said `fromAt` was read
 * for a `from` that was never there, and every workspace freeze arrived with no
 * window at all. Nothing failed: both suites were green, both sides logged
 * success, and the freeze governed nothing on any machine.
 *
 * So the contract is a file rather than a shared type — the repositories publish
 * separately and cannot import one another — and each side asserts against it.
 * The cloud's copy is byte-identical and its own test reads it the same way.
 */
const contractPath = join(
  fileURLToPath(new URL('../../..', import.meta.url)),
  'docs',
  'sync-contract.json',
);

interface Contract {
  bundle: Bundle;
  heartbeat: { runtimeVersion: string; bundleHashApplied: string; mode: string };
  heartbeatReply: { mode: string; modeApplied: string };
  events: { events: Record<string, unknown>[] };
  snapshot: EnvironmentSnapshot;
  census: { events: Record<string, unknown>[] };
}

async function contract(): Promise<Contract> {
  return JSON.parse(await readFile(contractPath, 'utf8')) as Contract;
}

describe('the bundle this machine is sent', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'memnox-contract-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('applies, with the rules where the gate reads them', async () => {
    const { bundle } = await contract();

    const result = await applyBundle(home, bundle);

    expect(result.outcome).toBe('applied');
    expect(result.rules).toBe(bundle.rules.length);
    expect(result.conditions).toBe(bundle.conditions.length);
  });

  /* The condition in the contract ended an hour after it began, in 2025. Read
     through the field names this side once used it had no window, was given a
     day from now, and would have been in force for a day every time it was
     pulled. That it is over is the assertion. */
  it('reads a finished condition as finished, not as one starting now', async () => {
    const { bundle } = await contract();
    await applyBundle(home, bundle);

    const facts = stateFactsInForce(
      await overlaysInForce(home),
      new Date().toISOString(),
    );

    expect(facts).not.toContain('freeze:deploys');
  });

  it('holds an open-ended condition, bounded from the last sync', async () => {
    const { bundle } = await contract();
    await applyBundle(home, bundle);

    const facts = stateFactsInForce(
      await overlaysInForce(home),
      new Date().toISOString(),
    );

    expect(facts).toContain('incident:*');
  });
});

/** The refused action the contract describes, as this machine's ledger holds it. */
const denied: MemnoxEvent = {
  id: 'evt_0001',
  schemaVersion: EVENT_SCHEMA_VERSION,
  at: new Date(1_757_000_123_000).toISOString(),
  sessionId: 'ses_01',
  agent: 'claude-code',
  actorType: 'agent',
  surface: EVENT_SURFACE.GIT,
  operation: 'git.push',
  target: 'origin/main',
  class: 'write',
  effect: DECISION_EFFECT.DENY,
  mode: ENFORCEMENT_MODE.ENFORCE,
  reason: 'main is shared.',
  rule: { name: 'no-force-push-to-main', layer: 'org', file: 'org.policies.json' },
  alternative: {
    action: 'push a branch and open a pull request',
    note: 'main is shared.',
  },
  policyHash: 'p1',
  argsDigest: 'sha256:9f2b',
  bundleHash: BUNDLE_HASH,
  conditionsInForce: ['cnd_deploy_freeze'],
};

/** And the held one, released by a person, which is the row with an approval. */
const asked: MemnoxEvent = {
  id: 'evt_0002',
  schemaVersion: EVENT_SCHEMA_VERSION,
  at: new Date(1_757_000_456_000).toISOString(),
  sessionId: 'ses_01',
  agent: 'claude-code',
  actorType: 'agent',
  surface: EVENT_SURFACE.MCP,
  operation: 'github.merge_pull_request',
  target: 'acme/web#412',
  class: 'write',
  effect: DECISION_EFFECT.ASK,
  mode: ENFORCEMENT_MODE.ENFORCE,
  reason: 'a merge is somebody else\u2019s call',
  rule: { name: 'ask-before-merge', layer: 'org', file: 'org.policies.json' },
  policyHash: 'p1',
  bundleHash: BUNDLE_HASH,
  authorizedBy: 'tresor',
  exitCode: 0,
  durationMs: 1200,
};

describe('the batch this machine sends', () => {
  /* One action is not one row: it opens its session, it is the action itself, and
     when it was held it asks for and resolves an approval. Every one of those is a
     table the console reads, and each was a table nothing ever wrote to. */
  it('is every row the control plane projects from what happened', async () => {
    const { events } = await contract();

    expect(fitting([denied, asked]).drafts).toEqual(events.events);
  });

  it('reports an approved hold as allowed, not as still waiting', async () => {
    const recorded = fitting([asked]).drafts.find(
      (draft) => draft['kind'] === 'agent.action.recorded',
    ) as { payload: Record<string, unknown> };

    expect(recorded.payload['effect']).toBe('ask');
    expect(recorded.payload['finalEffect']).toBe('allow');
  });

  it('leaves an unanswered hold open', () => {
    const { authorizedBy: _released, exitCode: _ran, ...waiting } = asked;

    const kinds = fitting([waiting]).drafts.map((draft) => draft['kind']);

    expect(kinds).toContain('approval.requested');
    expect(kinds).not.toContain('approval.resolved');
  });

  /* The post limit is counted in rows and an action can be four of them, so a batch
     sized by actions would be refused whole. */
  it('never posts more rows than the control plane takes', () => {
    const many = Array.from({ length: 400 }, (_, at) => ({
      ...asked,
      id: `evt_${at}`,
      sessionId: `ses_${at}`,
    }));

    const { drafts, through } = fitting(many);

    expect(drafts.length).toBeLessThanOrEqual(500);
    expect(through.length).toBeLessThan(many.length);
  });
});

/**
 * The one exchange that carries a mode in both directions, and they are not the
 * same field: up is what this machine is running, down is what the workspace has
 * set. A version of either side that read one as the other would report a
 * graduation as already done.
 */
describe('the heartbeat this machine reports', () => {
  it('names every mode the control plane may set', async () => {
    const { heartbeat, heartbeatReply } = await contract();

    expect(isEnforcementMode(heartbeat.mode)).toBe(true);
    expect(isEnforcementMode(heartbeatReply.mode)).toBe(true);
    expect(isEnforcementMode(heartbeatReply.modeApplied)).toBe(true);
  });

  /* Deliberately unequal in the example: that is the state a graduation passes
     through, and it is the one both halves have to render honestly. */
  it('shows what was asked for apart from what is running', async () => {
    const { heartbeatReply } = await contract();

    expect(heartbeatReply.mode).not.toBe(heartbeatReply.modeApplied);
  });
});

describe('the census this machine sends', () => {
  /* The ledger answers what an agent did. Nothing ever carried what it can do, and
     the projection built to receive it was empty for every workspace. */
  it('names every agent and everything each one reaches', async () => {
    const { snapshot, census } = await contract();

    expect(censusFrom(snapshot)).toEqual(census.events);
  });

  it('keys a row per scan, so the same agent seen again is not read as a resend', async () => {
    const { snapshot } = await contract();
    const later = { ...snapshot, takenAt: new Date().toISOString() };

    const before = censusFrom(snapshot).map((row) => row['dedupKey']);
    const after = censusFrom(later).map((row) => row['dedupKey']);

    expect(after).not.toEqual(before);
  });
});

/**
 * The whole pull, over a socket.
 *
 * Everything above tests one hop. This one starts a server that answers exactly
 * what `docs/sync-contract.json` says the control plane answers, points a machine
 * at it, and asks the gate a question afterwards — because every defect this seam
 * has had was in a hop that each side tested alone and neither tested together.
 */
describe('a machine pulling from a control plane', () => {
  let home: string;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'memnox-e2e-'));
    const { bundle } = await contract();
    // An hour from now, so the freeze is live while the test runs.
    const live = structuredClone(bundle);
    live.conditions[0]!.untilAt = Date.now() + 60 * 60 * 1000;

    server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.setHeader('etag', `"${live.hash}"`);
      if (request.headers['if-none-match'] === `"${live.hash}"`) {
        response.statusCode = 304;
        response.end();
        return;
      }
      response.end(JSON.stringify(live));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  });

  const account = (): Account => ({
    version: 1,
    baseUrl,
    workspaceId: 'ws_1',
    machineId: 'mch_1',
    token: 'tok_1',
    privateKey: 'unused here',
    enrolledAt: new Date().toISOString(),
  });

  it('ends up enforcing what the workspace declared', async () => {
    const pulled = await pullBundle(home, account());
    expect(pulled.outcome).toBe('applied');

    const facts = stateFactsInForce(
      await overlaysInForce(home),
      new Date().toISOString(),
    );

    expect(facts).toContain('freeze:deploys');
  });

  /* An open-ended condition is held for a day past the last sync, so a machine that
     keeps syncing keeps holding it. The 304 is the ordinary answer, so a horizon
     that only moved on a changed bundle would let a standing incident lapse on
     every machine still faithfully checking in. */
  it('moves the horizon of an open-ended condition on a 304', async () => {
    const first = await pullBundle(home, account());
    expect(first.outcome).toBe('applied');

    const path = join(home, '.memnox', 'org-conditions.json');
    const held = JSON.parse(await readFile(path, 'utf8')) as { conditions: unknown[] };
    await writeFile(
      path,
      JSON.stringify({ ...held, syncedAt: Date.now() - 2 * 24 * 60 * 60 * 1000 }),
    );
    expect(
      stateFactsInForce(await overlaysInForce(home), new Date().toISOString()),
    ).not.toContain('incident:*');

    await pullBundle(home, account(), first.hash);

    expect(
      stateFactsInForce(await overlaysInForce(home), new Date().toISOString()),
    ).toContain('incident:*');
  });

  it('keeps enforcing it when the next pull is a 304', async () => {
    const first = await pullBundle(home, account());
    const again = await pullBundle(home, account(), first.hash);
    expect(again.outcome).toBe('unchanged');

    const facts = stateFactsInForce(
      await overlaysInForce(home),
      new Date().toISOString(),
    );

    expect(facts).toContain('freeze:deploys');
  });
});
