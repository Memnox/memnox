import { beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_KIND,
  DECISION_EFFECT,
  EXPLANATION_EVIDENCE,
  SCOPE_MATCH,
  TASK_DECLARED_BY,
} from '@memnox/core';
import { PolicyEngine, type Policy } from '@memnox/policy-engine';
import { ActionGateway } from '../src/action-gateway';
import { InMemoryApprovalStore } from '../src/stores/in-memory-approval-store';
import { InMemoryAuditLog } from '../src/stores/in-memory-audit-log';
import { InMemoryExplanationStore } from '../src/stores/in-memory-explanation-store';
import { InMemoryIdentityStore } from '../src/stores/in-memory-identity-store';
import { InMemoryTaskStore } from '../src/stores/in-memory-task-store';

const POLICIES: Policy[] = [
  {
    name: 'secrets-not-required',
    match: {
      actions: ['filesystem.read'],
      targets: ['.env'],
      scope: [SCOPE_MATCH.OUT_OF_SCOPE],
    },
    decision: {
      effect: DECISION_EFFECT.WITHHOLD,
      reason: 'This task declared no credential need.',
      alternative: {
        action: 'filesystem.read',
        resource: '.env.example',
        note: '.env.example is readable.',
      },
    },
  },
];

const SESSION = 'ses_auth_tests';

describe('a session that declared what it was asked for', () => {
  let gateway: ActionGateway;
  let tasks: InMemoryTaskStore;
  let explanations: InMemoryExplanationStore;

  beforeEach(async () => {
    tasks = new InMemoryTaskStore();
    explanations = new InMemoryExplanationStore();
    gateway = new ActionGateway({
      identityStore: new InMemoryIdentityStore(),
      auditLog: new InMemoryAuditLog(),
      approvalStore: new InMemoryApprovalStore(),
      policyEngine: new PolicyEngine(POLICIES),
      tasks,
      explanations,
    });
    await tasks.save({
      id: 'tsk_1',
      sessionId: SESSION,
      subjectId: 'agt_1',
      statement: 'fix the failing auth tests',
      declaredScope: { paths: ['src/auth/*'] },
      declaredBy: TASK_DECLARED_BY.HUMAN,
      startedAt: '2026-08-31T09:00:00.000Z',
    });
  });

  const read = { action: 'filesystem.read', target: '.env', sessionId: SESSION };

  it('withholds a read the task did not cover, and names what to use instead', async () => {
    const { token } = await gateway.registerAgent('claude-code', AGENT_KIND.CLAUDE_CODE);

    const decision = await gateway.authorize(token, read);

    expect(decision.effect).toBe(DECISION_EFFECT.WITHHOLD);
    expect(decision.alternative?.resource).toBe('.env.example');
    expect(decision.rule?.name).toBe('secrets-not-required');
  });

  it('allows the same read once the task declares that path', async () => {
    await tasks.save({
      id: 'tsk_1',
      sessionId: SESSION,
      subjectId: 'agt_1',
      statement: 'rotate the local credentials',
      declaredScope: { paths: ['.env'] },
      declaredBy: TASK_DECLARED_BY.HUMAN,
      startedAt: '2026-08-31T09:00:00.000Z',
    });
    const { token } = await gateway.registerAgent('claude-code', AGENT_KIND.CLAUDE_CODE);

    const decision = await gateway.authorize(token, read);

    expect(decision.effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('allows it when no task was declared, because undeclared is not out of scope', async () => {
    const { token } = await gateway.registerAgent('claude-code', AGENT_KIND.CLAUDE_CODE);

    const decision = await gateway.authorize(token, {
      action: 'filesystem.read',
      target: '.env',
      sessionId: 'ses_undeclared',
    });

    expect(decision.effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('stores an explanation citing the rule and the scope it compared', async () => {
    const { token } = await gateway.registerAgent('claude-code', AGENT_KIND.CLAUDE_CODE);
    const decision = await gateway.authorize(token, read);

    const explanation = await explanations.findByDecision(decision.eventId);

    expect(explanation).not.toBeNull();
    expect(
      explanation?.lines.some(
        (line) => line.evidence.kind === EXPLANATION_EVIDENCE.SCOPE,
      ),
    ).toBe(true);
    expect(
      explanation?.lines.some((line) => line.evidence.kind === EXPLANATION_EVIDENCE.RULE),
    ).toBe(true);
  });

  it('stamps the mode and the evaluation latency on every verdict', async () => {
    const { token } = await gateway.registerAgent('claude-code', AGENT_KIND.CLAUDE_CODE);

    const decision = await gateway.authorize(token, read);

    expect(decision.mode).toBe('enforce');
    expect(decision.latencyUs).toBeGreaterThanOrEqual(0);
    expect(Date.parse(decision.evaluatedAt)).not.toBeNaN();
  });
});
