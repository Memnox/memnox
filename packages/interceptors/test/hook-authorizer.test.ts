import { DECISION_EFFECT, type ActionRequest, type Decision } from '@memnox/core';
import { LocalGate } from '@memnox/core';
import { describe, expect, it } from 'vitest';
import { HookAuthorizer, HookAuthorizer as RealAuthorizer } from '../src/hook-authorizer';

const read: ActionRequest = {
  action: 'filesystem.read',
  target: '/srv/app/.env',
  arguments: { file_path: '/srv/app/.env' },
};

/** Typed by inference: the shape is the policy file a person would write. */
const denyEnv = {
  name: 'secrets-not-required',
  match: { actions: ['filesystem.read'], targets: ['*.env'] },
  decision: {
    effect: DECISION_EFFECT.DENY,
    reason: 'no credential need was declared',
    alternative: {
      action: 'filesystem.read',
      resource: '.env.example',
      note: 'readable',
    },
  },
};

const gate = (): LocalGate => new LocalGate([denyEnv], { agentName: 'claude-code' });

/** Records what was asked, so the arguments never leaving the machine is testable. */
function authorizer(deps: { gate?: LocalGate; failOpen?: boolean }): HookAuthorizer {
  return new HookAuthorizer({
    ...(deps.gate === undefined ? {} : { gate: deps.gate }),
    ...(deps.failOpen === undefined ? {} : { failOpen: deps.failOpen }),
    log: () => {},
  });
}

describe('HookAuthorizer', () => {
  it('carries the local rule’s alternative, so offline is not a dead end', async () => {
    const verdict = await authorizer({ gate: gate() }).authorize(read);
    expect(verdict.effect).toBe(DECISION_EFFECT.DENY);
    expect(verdict.alternative?.resource).toBe('.env.example');
  });

  it('allows when nothing is configured, and names that as the reason', async () => {
    const verdict = await authorizer({}).authorize(read);
    expect(verdict.effect).toBe(DECISION_EFFECT.ALLOW);
    expect(verdict.reason).toBe('no rules configured');
  });
});

const AWS_KEY = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');

describe('egress, before anything leaves this machine', () => {
  it('denies a credential bound for a host no rule forbids', async () => {
    const verdict = await authorizer({}).authorize({
      action: 'http.request',
      target: 'https://api.partner.example/ingest',
      arguments: { body: `key=${AWS_KEY}` },
    });

    expect(verdict.effect).toBe(DECISION_EFFECT.DENY);
    expect(verdict.reason).toContain('body');
    // Never silently strip: the refusal names the field, never the value.
    expect(verdict.reason).not.toContain(AWS_KEY);
  });

  it('names what to do instead, so the refusal is not a dead end', async () => {
    const verdict = await authorizer({}).authorize({
      action: 'http.request',
      target: 'https://example.com',
      arguments: { password: 'hunter2' },
    });
    expect(verdict.alternative?.note).toContain('without that field');
  });

  it('leaves an ordinary request alone', async () => {
    const verdict = await authorizer({}).authorize({
      action: 'http.request',
      target: 'https://example.com',
      arguments: { body: 'hello' },
    });
    expect(verdict.effect).toBe(DECISION_EFFECT.ALLOW);
  });
});
