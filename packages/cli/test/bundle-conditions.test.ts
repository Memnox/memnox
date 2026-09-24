import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DECISION_EFFECT, LocalGate, loadPoliciesFromFile } from '@memnox/core';

import {
  applyBundle,
  documentFrom,
  orgPolicyPath,
  PULL_OUTCOME,
  type Bundle,
  type BundleRule,
} from '../src/sync/bundle';

/**
 * The team's copy of a rule a machine wrote for itself has to match exactly what the
 * source matched. `memnox setup` denies reading `~/.ssh`, `~/.aws` and `.env` files; the
 * copy that came back down named no targets, so every machine that pulled it refused
 * every file read.
 */

const CREDENTIAL_TARGETS = [
  '**/.ssh',
  '**/.ssh/**',
  '**/.aws',
  '**/.aws/**',
  '**/.gcloud',
  '**/.gcloud/**',
  '**/.kube',
  '**/.kube/**',
  '**/.env',
  '**/.env.*',
];

/** The credentials deny as the control plane sends it: under the spelling a pre-scope runtime skips. */
const CREDENTIALS_DENY: BundleRule = {
  id: '542631307680a248b68c11a8fc94a005',
  policyHash: 'p1',
  line: 1,
  domain: 'filesystem',
  effect: DECISION_EFFECT.DENY,
  specificity: 15,
  match: 'memnox.requires-scoped-rules',
  scopedMatch: 'filesystem.read',
  targets: CREDENTIAL_TARGETS,
  reason: 'you chose to deny this: almost no task needs the key itself',
};

const bundleOf = (rules: BundleRule[]): Bundle => ({
  hash: 'h1',
  policies: [],
  rules,
  conditions: [],
  tags: [],
});

interface Written {
  policies: { name: string; match: Record<string, unknown> }[];
}

describe('a published rule reaches the gate with every condition it was published with', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'memnox-bundle-conditions-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('keeps the targets, so only credential files are refused', async () => {
    const result = await applyBundle(home, bundleOf([CREDENTIALS_DENY]));
    expect(result.outcome).toBe(PULL_OUTCOME.APPLIED);

    const policies = await loadPoliciesFromFile(orgPolicyPath(home));
    expect(policies[0]?.match.actions).toEqual(['filesystem.read']);
    expect(policies[0]?.match.targets).toEqual(CREDENTIAL_TARGETS);

    const gate = new LocalGate(policies, { agentName: 'claude-code' });
    const read = (target: string): string =>
      gate.evaluate({ action: 'filesystem.read', target }).effect;
    expect(read('/home/dev/.ssh/id_ed25519')).toBe(DECISION_EFFECT.DENY);
    expect(read('/home/dev/app/.env')).toBe(DECISION_EFFECT.DENY);
    expect(read('/home/dev/app/README.md')).toBe(DECISION_EFFECT.ALLOW);
  });

  it('keeps every action a rule names', () => {
    const document = documentFrom(
      bundleOf([
        {
          id: 'r2',
          policyHash: 'p1',
          line: 2,
          domain: 'git',
          effect: DECISION_EFFECT.DENY,
          specificity: 14,
          match: 'git.push-force',
          actions: ['git.push-force', 'git.reset-hard', 'git.clean'],
        },
      ]),
    ) as Written;

    expect(document.policies[0]?.match).toEqual({
      actions: ['git.push-force', 'git.reset-hard', 'git.clean'],
    });
  });

  it('carries every other condition onto the match, and the gate holds the rule to it', async () => {
    const conditioned: BundleRule = {
      id: 'r3',
      policyHash: 'p1',
      line: 3,
      domain: 'deploy',
      effect: DECISION_EFFECT.DENY,
      specificity: 10,
      match: 'memnox.requires-conditioned-rules',
      actions: ['deploy.run'],
      conditions: { environments: ['production'], unless: [{ project: 'sandbox' }] },
      unless: [{ agents: ['release-bot'] }],
    };

    expect((documentFrom(bundleOf([conditioned])) as Written).policies[0]?.match).toEqual(
      {
        actions: ['deploy.run'],
        environments: ['production'],
        unless: [{ project: 'sandbox' }, { agents: ['release-bot'] }],
      },
    );

    await applyBundle(home, bundleOf([conditioned]));
    const gate = new LocalGate(await loadPoliciesFromFile(orgPolicyPath(home)), {
      agentName: 'claude-code',
    });
    const deploy = (environment: string): string =>
      gate.evaluate({ action: 'deploy.run', environment }).effect;
    expect(deploy('production')).toBe(DECISION_EFFECT.DENY);
    expect(deploy('staging')).toBe(DECISION_EFFECT.ALLOW);
  });

  /* The validator drops a match key it does not know, so a condition from a newer control
     plane would be read as no condition at all: the rule is skipped instead. */
  it('skips a rule naming a condition this gate cannot honour, rather than widening it', () => {
    const document = documentFrom(
      bundleOf([
        {
          ...CREDENTIALS_DENY,
          id: 'r4',
          match: 'memnox.requires-conditioned-rules',
          actions: ['filesystem.read'],
          conditions: { owners: ['ana'] },
        },
        CREDENTIALS_DENY,
      ]),
    ) as Written;

    expect(document.policies.map((policy) => policy.name)).toEqual([CREDENTIALS_DENY.id]);
  });
});
