import { beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_KIND,
  CONTEXT_TRUST,
  DECISION_EFFECT,
  TASK_DECLARED_BY,
} from '@memnox/core';
import { FRAME_KIND } from '@memnox/ledger';
import { PolicyEngine, type Policy } from '@memnox/policy-engine';
import { ActionGateway } from '../src/action-gateway';
import { LearnService } from '../src/learn-service';
import { InMemoryApprovalStore } from '../src/stores/in-memory-approval-store';
import { InMemoryAuditLog } from '../src/stores/in-memory-audit-log';
import { InMemoryFrameStore } from '../src/stores/jsonl-frame-store';
import { InMemoryIdentityStore } from '../src/stores/in-memory-identity-store';
import { InMemoryTaskStore } from '../src/stores/in-memory-task-store';

const POLICIES: Policy[] = [
  {
    name: 'no-prod-deletes',
    match: { actions: ['database.delete'], environments: ['production'] },
    decision: { effect: DECISION_EFFECT.WITHHOLD, reason: 'never' },
  },
  {
    name: 'cloud-writes-ask',
    match: { actions: ['cloud.write'] },
    decision: { effect: DECISION_EFFECT.ESCALATE, approvers: ['you'] },
  },
];

const SESSION = 'ses_1';

describe('the flight recorder', () => {
  let gateway: ActionGateway;
  let frames: InMemoryFrameStore;
  let token: string;

  beforeEach(async () => {
    frames = new InMemoryFrameStore();
    const tasks = new InMemoryTaskStore();
    await tasks.save({
      id: 'tsk_1',
      sessionId: SESSION,
      subjectId: 'agt',
      statement: 'fix the failing auth tests',
      declaredScope: {},
      declaredBy: TASK_DECLARED_BY.HUMAN,
      startedAt: '2026-08-31T09:00:00.000Z',
    });
    gateway = new ActionGateway({
      identityStore: new InMemoryIdentityStore(),
      auditLog: new InMemoryAuditLog(),
      approvalStore: new InMemoryApprovalStore(),
      policyEngine: new PolicyEngine(POLICIES),
      frames,
      tasks,
    });
    token = (await gateway.registerAgent('claude-code', AGENT_KIND.CLAUDE_CODE)).token;
  });

  it('keeps every frame of a withheld action, whatever the sampling says', async () => {
    await gateway.authorize(token, {
      action: 'database.delete',
      target: 'users',
      environment: 'production',
      sessionId: SESSION,
    });

    const recorded = await frames.bySession(SESSION);
    expect(recorded.some((frame) => frame.kind === FRAME_KIND.VERDICT)).toBe(true);
  });

  it('hashes what an agent read rather than keeping it', async () => {
    await gateway.authorize(token, {
      action: 'database.delete',
      environment: 'production',
      sessionId: SESSION,
      context: [
        {
          source: 'mcp:github/get_issue',
          trust: CONTEXT_TRUST.UNTRUSTED,
          content: 'AKIAEXAMPLE',
        },
      ],
    });

    const recorded = await frames.bySession(SESSION);
    const retrieval = recorded.find((frame) => frame.kind === FRAME_KIND.RETRIEVAL);
    expect(retrieval?.payloadDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(retrieval?.contextTrust).toBe(CONTEXT_TRUST.UNTRUSTED);
    expect(JSON.stringify(recorded)).not.toContain('AKIAEXAMPLE');
  });

  it('records nothing for a session that declared none, rather than inventing one', async () => {
    await gateway.authorize(token, { action: 'repository.read' });

    expect(await frames.bySession(SESSION)).toEqual([]);
  });
});

describe('learning from a day of work', () => {
  it('proposes rules from behaviour, and names what was never used', async () => {
    const auditLog = new InMemoryAuditLog();
    const gateway = new ActionGateway({
      identityStore: new InMemoryIdentityStore(),
      auditLog,
      approvalStore: new InMemoryApprovalStore(),
      policyEngine: new PolicyEngine(POLICIES),
    });
    const { token } = await gateway.registerAgent('claude-code', AGENT_KIND.CLAUDE_CODE);
    await gateway.authorize(token, { action: 'repository.read', sessionId: SESSION });
    await gateway.authorize(token, { action: 'shell.execute', sessionId: SESSION });

    const learn = new LearnService({
      auditLog,
      rules: () => POLICIES,
      seams: async () => [],
    });
    const [result] = await learn.learn(7);

    expect(result).toBeDefined();
    expect(result?.proposal.allow).toContain('repository.read');
    // Used, but never without a person: some actions stay behind one however often.
    expect(result?.proposal.requireApproval).toContain('shell.execute');
    expect(result?.proposal.deny).toContain('database.delete');
  });

  it('states the window and the sessions on the file it writes', async () => {
    const auditLog = new InMemoryAuditLog();
    const gateway = new ActionGateway({
      identityStore: new InMemoryIdentityStore(),
      auditLog,
      approvalStore: new InMemoryApprovalStore(),
      policyEngine: new PolicyEngine(POLICIES),
    });
    const { token } = await gateway.registerAgent('claude-code', AGENT_KIND.CLAUDE_CODE);
    await gateway.authorize(token, { action: 'repository.read', sessionId: SESSION });

    const learn = new LearnService({
      auditLog,
      rules: () => POLICIES,
      seams: async () => [],
    });
    const [result] = await learn.learn(4);

    expect(result?.policyFile).toContain('4 day(s), 1 session(s)');
    expect(result?.policyFile).toContain('version: 1');
  });

  it('says nothing when no agent has acted', async () => {
    const learn = new LearnService({
      auditLog: new InMemoryAuditLog(),
      rules: () => POLICIES,
      seams: async () => [],
    });

    expect(await learn.learn(7)).toEqual([]);
  });
});
