import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import type { ActionEvent } from '@memnox/core';
import { buildServer, type MemnoxServer } from '../src/server';
import type { Ownership } from '@memnox/org-graph';
import type {
  AgentCandidate,
  ContextResponse,
  Decided,
  EvaluateResponse,
  Precedent,
  ShareResponse,
} from '../src/organization-service';

const POLICY_YAML = `
version: 1
policies:
  - name: large-refund-approval
    match:
      actions: ["payment.refund"]
      aboveAmount: 1000
    decision:
      effect: require_approval
      reason: Refunds above 1,000 need the Finance Manager
      approvers: ["finance-manager"]
  - name: no-database-deletion
    match:
      actions: ["database.delete"]
    decision:
      effect: block
      reason: Never
`;

const WORKSPACE = 'default';

describe('the organization protocol', () => {
  let dataDir: string;
  let server: MemnoxServer;
  let token: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-org-'));
    const policyFile = join(dataDir, 'policies.yaml');
    await writeFile(policyFile, POLICY_YAML, 'utf8');
    server = await buildServer({
      dataDir,
      policyFile,
      enforcement: { default: 'enforce' },
    });
    const registration = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { name: 'finance-bot', kind: 'custom' },
    });
    token = (registration.json() as { token: string }).token;
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const ask = (
    path: string,
    payload: Record<string, unknown>,
  ): Promise<LightMyRequestResponse> =>
    server.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${WORKSPACE}${path}`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

  const evaluate = async (payload: Record<string, unknown>): Promise<EvaluateResponse> =>
    (await ask('/evaluate', payload)).json() as EvaluateResponse;

  const admin = (
    method: 'POST' | 'GET',
    url: string,
    payload?: Record<string, unknown>,
  ): Promise<LightMyRequestResponse> => server.app.inject({ method, url, payload });

  const state = async (fields: Record<string, unknown>): Promise<string> => {
    const response = await admin('POST', '/v1/organization/statements', fields);
    return (response.json() as { id: string }).id;
  };

  describe('evaluate', () => {
    it('allows an action no rule holds, and says delegation was never assessed', async () => {
      const answer = await evaluate({ action: 'email.draft' });

      expect(answer.decision).toBe('allow');
      expect(answer.delegationNotAssessed).toBe(true);
    });

    it('denies what the gate blocks, and nothing widens it', async () => {
      const answer = await evaluate({
        action: 'database.delete',
        resource: { id: 'production.users' },
      });

      expect(answer.decision).toBe('deny');
      expect(answer.approvers).toEqual([]);
    });

    it('escalates to the person the rule names, with an approval to wait on', async () => {
      const answer = await evaluate({ action: 'payment.refund', amount: 4_500 });

      expect(answer.decision).toBe('escalate');
      expect(answer.approvers.map((approver) => approver.id)).toContain(
        'finance-manager',
      );
      expect(answer.approvalId).toBeDefined();
    });

    it('attaches the warrant when the organization states one', async () => {
      await state({
        kind: 'authority',
        statement: 'The Finance Manager approves refunds up to 50,000.',
        subject: 'payment.refund',
        principal: 'finance-manager',
        capability: 'payment.*',
        limit: 50_000,
      });

      const answer = await evaluate({ action: 'payment.refund', amount: 4_500 });
      const approver = answer.approvers.find((entry) => entry.id === 'finance-manager');

      expect(approver?.because).toContain('approves refunds up to 50,000');
      expect(approver?.limit).toBe(50_000);
    });

    it('delegates when the action relies on a fact the caller may not read', async () => {
      const secret = await state({
        kind: 'decision',
        statement: 'Executive compensation is reviewed in March.',
        subject: 'compensation',
        clearance: ['cfo@acme.com'],
      });

      const answer = await evaluate({
        action: 'email.draft',
        principal: 'intern@acme.com',
        reads: [secret],
      });

      expect(answer.decision).toBe('delegate');
      expect(answer.missingContext).toEqual([secret]);
      expect(answer.reason).toContain('not cleared to read');
    });

    it('allows the same action for the person who is cleared', async () => {
      const secret = await state({
        kind: 'decision',
        statement: 'Executive compensation is reviewed in March.',
        subject: 'compensation',
        clearance: ['cfo@acme.com'],
      });

      const answer = await evaluate({
        action: 'email.draft',
        principal: 'cfo@acme.com',
        reads: [secret],
      });

      expect(answer.decision).toBe('allow');
      expect(answer.missingContext).toEqual([]);
    });

    it('clarifies when the caller cites a fact this organization does not hold', async () => {
      const answer = await evaluate({
        action: 'email.draft',
        principal: 'alice',
        reads: ['fact-that-never-existed'],
      });

      expect(answer.decision).toBe('clarify');
      expect(answer.reason).toContain('not held by this organization');
    });

    it('carries the constraints a bearing policy states', async () => {
      await state({
        kind: 'policy',
        statement: 'Never refund to a card other than the one charged.',
        subject: 'payment.refund',
      });

      const answer = await evaluate({ action: 'payment.refund', amount: 10 });

      expect(answer.constraints).toContain(
        'Never refund to a card other than the one charged.',
      );
    });

    it('reports what it withheld without naming it', async () => {
      await state({
        kind: 'policy',
        statement: 'Refunds over 100,000 go to the board.',
        subject: 'payment.refund',
        clearance: ['cfo@acme.com'],
      });

      const answer = await evaluate({
        action: 'payment.refund',
        amount: 10,
        principal: 'intern@acme.com',
      });

      expect(answer.withheld).toBe(1);
      expect(JSON.stringify(answer)).not.toContain('go to the board');
    });

    it('audits the evaluation like any other action, with the principal on it', async () => {
      await evaluate({ action: 'payment.refund', amount: 10, principal: 'alice' });

      const audit = await server.app.inject({ method: 'GET', url: '/v1/audit' });
      const events = audit.json() as ActionEvent[];
      const refund = events.find((event) => event.action === 'payment.refund');

      expect(refund?.principal).toBe('alice');
    });

    it('refuses a workspace the credential is not entitled to', async () => {
      const response = await server.app.inject({
        method: 'POST',
        url: '/v1/workspaces/somebody-elses-company/evaluate',
        headers: { authorization: `Bearer ${token}` },
        payload: { action: 'email.draft' },
      });

      expect(response.statusCode).toBe(401);
    });

    it('refuses an unknown credential', async () => {
      const response = await server.app.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/evaluate`,
        headers: { authorization: 'Bearer not-a-token' },
        payload: { action: 'email.draft' },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('the questions that lead to a decision', () => {
    it('names an owner through the statement that made them one', async () => {
      await state({
        kind: 'responsibility',
        statement: 'Platform Engineering owns production services.',
        subject: 'production.*',
        object: 'platform-engineering',
      });

      const response = await ask('/ask/owner', { subject: 'production.checkout' });
      const owned = response.json() as Ownership;

      expect(owned.owners.map((owner) => owner.name)).toEqual(['platform-engineering']);
    });

    it('answers with nobody rather than guessing an owner', async () => {
      const response = await ask('/ask/owner', { subject: 'nothing-recorded' });

      expect((response.json() as Ownership).owners).toEqual([]);
    });

    it('returns what has already been decided about a topic', async () => {
      await state({
        kind: 'decision',
        statement: 'We standardised on PostgreSQL for transactional systems.',
        subject: 'database',
      });

      const response = await ask('/ask/decisions', { topic: 'database' });
      const decided = response.json() as Decided[];

      expect(decided[0]?.statement).toContain('PostgreSQL');
    });

    it('reads context filtered to the asking principal', async () => {
      await state({
        kind: 'policy',
        statement: 'Refund approvals are logged to the finance channel.',
        subject: 'refund',
        clearance: ['cfo@acme.com'],
      });

      const response = await ask('/ask/context', {
        question: 'refund approvals',
        principal: 'intern@acme.com',
      });
      const answer = response.json() as ContextResponse;

      expect(answer.facts).toEqual([]);
      expect(answer.withheld).toBe(1);
    });

    it('names another agent for an action, and never itself', async () => {
      await server.app.inject({
        method: 'POST',
        url: '/v1/agents',
        payload: {
          name: 'refund-bot',
          kind: 'custom',
          capabilities: ['payment.refund'],
        },
      });

      const response = await ask('/ask/agents', { action: 'payment.refund' });
      const candidates = response.json() as AgentCandidate[];

      expect(candidates.map((entry) => entry.label)).toContain('refund-bot');
      expect(candidates.map((entry) => entry.label)).not.toContain('finance-bot');
    });

    it('reports how the same action was routed before, and to whom', async () => {
      await evaluate({ action: 'payment.refund', amount: 4_500 });

      const response = await ask('/ask/precedent', { action: 'payment.refund' });
      const history = response.json() as Precedent[];

      expect(history[0]?.verb).toBe('escalate');
      expect(history[0]?.to).toContain('finance-manager');
    });

    it('carries no content in precedent, only how it was routed', async () => {
      await evaluate({ action: 'database.delete', reason: 'clearing test data' });

      const response = await ask('/ask/precedent', { action: 'database.delete' });
      const history = response.json() as Precedent[];

      expect(history[0]?.verb).toBe('deny');
      expect(history[0]?.to).toEqual([]);
    });

    it('refuses to share a fact with somebody not cleared for it', async () => {
      const secret = await state({
        kind: 'decision',
        statement: 'The acquisition closes in Q3.',
        subject: 'acquisition',
        clearance: ['cfo@acme.com'],
      });
      await state({
        kind: 'responsibility',
        statement: 'Dana runs support.',
        subject: 'support',
        object: 'dana@acme.com',
      });

      const response = await ask('/ask/can-share', {
        factId: secret,
        recipient: 'dana@acme.com',
      });
      const answer = response.json() as ShareResponse;

      expect(answer.shareable).toBe(false);
      expect(answer.refusal).not.toContain('acquisition closes');
    });

    it('says a recipient is unknown rather than refusing on their behalf', async () => {
      const fact = await state({
        kind: 'decision',
        statement: 'We ship on Thursdays.',
        subject: 'release',
      });

      const response = await ask('/ask/can-share', {
        factId: fact,
        recipient: 'nobody@nowhere.test',
      });

      expect(response.json()).toEqual({ shareable: false, unknownRecipient: true });
    });

    it('says a fact is unknown when it is not held', async () => {
      const response = await ask('/ask/can-share', {
        factId: 'no-such-fact',
        recipient: 'anyone',
      });

      expect(response.json()).toEqual({ shareable: false, unknownFact: true });
    });
  });

  describe('delegated authority', () => {
    const delegate = (fields: Record<string, unknown>): Promise<LightMyRequestResponse> =>
      admin('POST', '/v1/organization/authority', fields);

    it('escalates an agent past the ceiling its principal delegated', async () => {
      await delegate({
        principal: 'alice@acme.com',
        actions: ['expense.approve'],
        limit: 5_000,
      });

      const under = await evaluate({
        action: 'expense.approve',
        amount: 4_000,
        principal: 'alice@acme.com',
      });
      const over = await evaluate({
        action: 'expense.approve',
        amount: 6_000,
        principal: 'alice@acme.com',
      });

      expect(under.decision).toBe('allow');
      expect(over.decision).toBe('escalate');
      expect(over.approvers.map((approver) => approver.id)).toContain('alice@acme.com');
    });

    it('escalates an action outside the remit a principal declared', async () => {
      await delegate({
        principal: 'alice@acme.com',
        actions: ['email.draft'],
      });

      const answer = await evaluate({
        action: 'contract.sign',
        principal: 'alice@acme.com',
      });

      expect(answer.decision).toBe('escalate');
    });

    it('leaves alone a principal nobody has delegated anything for', async () => {
      const answer = await evaluate({
        action: 'contract.sign',
        principal: 'bob@acme.com',
      });

      expect(answer.decision).toBe('allow');
    });
  });

  describe('statements a person enters and an extractor proposes', () => {
    it('binds a statement a person entered straight away', async () => {
      const id = await state({
        kind: 'policy',
        statement: 'Deploys freeze in December.',
        subject: 'deploy.service',
      });

      const answer = await evaluate({ action: 'deploy.service' });

      expect(answer.policies).toContain(id);
      expect(answer.constraints).toContain('Deploys freeze in December.');
    });

    it('binds nothing an extractor proposed until a person confirms it', async () => {
      const filed = await admin('POST', '/v1/organization/candidates', {
        candidates: [
          {
            id: 'candidate-1',
            workspaceId: WORKSPACE,
            kind: 'policy',
            statement: 'Somebody said deploys freeze in December.',
            subject: 'deploy.service',
            provenance: 'observed',
            status: 'candidate',
            version: 1,
            evidence: ['msg-1'],
            confidence: 0.9,
            detectedAt: '2026-05-01T00:00:00.000Z',
          },
        ],
      });
      expect(filed.statusCode).toBe(201);

      const before = await evaluate({ action: 'deploy.service' });
      expect(before.constraints).toEqual([]);

      await admin('POST', '/v1/organization/statements/candidate-1/verify', {
        by: 'alice',
      });

      const after = await evaluate({ action: 'deploy.service' });
      expect(after.constraints).toContain('Somebody said deploys freeze in December.');
    });

    it('refuses to verify anything that is not a candidate', async () => {
      const id = await state({
        kind: 'policy',
        statement: 'Already ours.',
        subject: 'deploy.service',
      });

      const response = await admin('POST', `/v1/organization/statements/${id}/verify`, {
        by: 'alice',
      });

      expect(response.statusCode).toBe(404);
    });

    it('retires the statement a new one replaces', async () => {
      const first = await state({
        kind: 'policy',
        statement: 'Deploys need one reviewer.',
        subject: 'deploy.service',
      });
      await state({
        kind: 'policy',
        statement: 'Deploys need two reviewers.',
        subject: 'deploy.service',
        supersedes: first,
      });

      const answer = await evaluate({ action: 'deploy.service' });

      expect(answer.constraints).toEqual(['Deploys need two reviewers.']);
    });
  });
});
