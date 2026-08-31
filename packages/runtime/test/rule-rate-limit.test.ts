import { beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_KIND,
  DECISION_EFFECT,
  FixedWindowRateLimiter,
  InProcessLockService,
} from '@memnox/core';
import { PolicyEngine, type Policy } from '@memnox/policy-engine';
import { ActionGateway } from '../src/action-gateway';
import { InMemoryApprovalStore } from '../src/stores/in-memory-approval-store';
import { InMemoryAuditLog } from '../src/stores/in-memory-audit-log';
import { InMemoryIdentityStore } from '../src/stores/in-memory-identity-store';

const THREE_PER_MINUTE: Policy = {
  name: 'three-deploys-a-minute',
  match: { actions: ['deploy.*'] },
  decision: {
    effect: DECISION_EFFECT.ALLOW,
    rateLimit: { max: 3, windowSeconds: 60 },
  },
};

const DEPLOY = { action: 'deploy.service', target: 'checkout' };

describe('per-rule rate limits', () => {
  let auditLog: InMemoryAuditLog;

  const gatewayWith = (policies: Policy[], limited = true): ActionGateway =>
    new ActionGateway({
      identityStore: new InMemoryIdentityStore(),
      auditLog,
      approvalStore: new InMemoryApprovalStore(),
      policyEngine: new PolicyEngine(policies),
      ...(limited
        ? { rateLimiter: new FixedWindowRateLimiter(new InProcessLockService()) }
        : {}),
    });

  const tokenFor = async (gateway: ActionGateway): Promise<string> => {
    const { token } = await gateway.registerAgent('claude-code', AGENT_KIND.CLAUDE_CODE);
    return token;
  };

  beforeEach(() => {
    auditLog = new InMemoryAuditLog();
  });

  it('allows up to the ceiling and blocks the call past it', async () => {
    const gateway = gatewayWith([THREE_PER_MINUTE]);
    const token = await tokenFor(gateway);

    const effects: string[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      effects.push((await gateway.authorize(token, DEPLOY)).effect);
    }

    expect(effects).toEqual([
      DECISION_EFFECT.ALLOW,
      DECISION_EFFECT.ALLOW,
      DECISION_EFFECT.ALLOW,
      DECISION_EFFECT.WITHHOLD,
    ]);
  });

  it('says which rule ran out, so the refusal is actionable', async () => {
    const gateway = gatewayWith([THREE_PER_MINUTE]);
    const token = await tokenFor(gateway);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await gateway.authorize(token, DEPLOY);
    }

    const decision = await gateway.authorize(token, DEPLOY);

    expect(decision.reason).toContain('three-deploys-a-minute');
    expect(decision.reason).toContain('3 per 60s');
  });

  it('counts per agent, so one agent cannot spend another’s budget', async () => {
    const gateway = gatewayWith([THREE_PER_MINUTE]);
    const first = await tokenFor(gateway);
    const second = await tokenFor(gateway);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await gateway.authorize(first, DEPLOY);
    }

    expect((await gateway.authorize(second, DEPLOY)).effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('never spends a slot on a call that was refused anyway', async () => {
    const gateway = gatewayWith([
      THREE_PER_MINUTE,
      {
        name: 'no-prod-deploys',
        match: { actions: ['deploy.*'], environments: ['production'] },
        decision: { effect: DECISION_EFFECT.WITHHOLD, reason: 'not from an agent' },
      },
    ]);
    const token = await tokenFor(gateway);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await gateway.authorize(token, { ...DEPLOY, environment: 'production' });
    }
    const afterwards = await gateway.authorize(token, DEPLOY);

    expect(afterwards.effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('leaves a observed rule inert — it counts nothing and blocks nothing', async () => {
    const gateway = gatewayWith([
      {
        ...THREE_PER_MINUTE,
        decision: { ...THREE_PER_MINUTE.decision, mode: 'observe' },
      },
    ]);
    const token = await tokenFor(gateway);

    const effects: string[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      effects.push((await gateway.authorize(token, DEPLOY)).effect);
    }

    expect(effects.every((effect) => effect === DECISION_EFFECT.ALLOW)).toBe(true);
  });

  it('is inert without a limiter, rather than silently pretending to count', async () => {
    const gateway = gatewayWith([THREE_PER_MINUTE], false);
    const token = await tokenFor(gateway);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await gateway.authorize(token, DEPLOY);
    }

    expect((await gateway.authorize(token, DEPLOY)).effect).toBe(DECISION_EFFECT.ALLOW);
  });
});

describe('a observed rule in the audit trail', () => {
  it('records the verdict it withheld while letting the action through', async () => {
    const auditLog = new InMemoryAuditLog();
    const gateway = new ActionGateway({
      identityStore: new InMemoryIdentityStore(),
      auditLog,
      approvalStore: new InMemoryApprovalStore(),
      policyEngine: new PolicyEngine([
        {
          name: 'candidate-block',
          match: { actions: ['deploy.*'] },
          decision: {
            effect: DECISION_EFFECT.WITHHOLD,
            mode: 'observe',
            reason: 'candidate rule',
          },
        },
      ]),
    });
    const { token } = await gateway.registerAgent('claude-code', AGENT_KIND.CLAUDE_CODE);

    const decision = await gateway.authorize(token, DEPLOY);
    const [event] = await auditLog.recent(1);

    expect(decision.effect).toBe(DECISION_EFFECT.ALLOW);
    expect(decision.shadowEffect).toBe(DECISION_EFFECT.WITHHOLD);
    expect(event?.shadowEffect).toBe(DECISION_EFFECT.WITHHOLD);
    expect(event?.matchedPolicies).toEqual(['candidate-block']);
  });
});

describe('what a caller’s own gate reported', () => {
  it('audits local signals apart from the runtime’s own advisories', async () => {
    const auditLog = new InMemoryAuditLog();
    const gateway = new ActionGateway({
      identityStore: new InMemoryIdentityStore(),
      auditLog,
      approvalStore: new InMemoryApprovalStore(),
      policyEngine: new PolicyEngine([]),
    });
    const { token } = await gateway.registerAgent('claude-code', AGENT_KIND.CLAUDE_CODE);

    await gateway.authorize(token, {
      action: 'mcp.create_issue',
      target: 'github',
      signals: ['shield:aws-access-key'],
      workingDirectory: '/srv/checkout',
      branch: 'main',
    });
    const [event] = await auditLog.recent(1);

    expect(event?.advisories).toEqual(['local:shield:aws-access-key']);
    expect(event?.workingDirectory).toBe('/srv/checkout');
    expect(event?.branch).toBe('main');
  });
});
