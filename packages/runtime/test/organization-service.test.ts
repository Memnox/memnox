import { beforeEach, describe, expect, it } from 'vitest';
import { PolicyEngine } from '@memnox/policy-engine';
import { ActionGateway } from '../src/action-gateway';
import { DecisionMemoryService } from '../src/decision-memory-service';
import {
  OrganizationService,
  type OrganizationServiceDeps,
  type ProposeResult,
} from '../src/organization-service';
import { InMemoryDecisionStore } from '@memnox/memory';
import { InMemoryApprovalStore } from '../src/stores/in-memory-approval-store';
import { InMemoryAuditLog } from '../src/stores/in-memory-audit-log';
import { InMemoryIdentityStore } from '../src/stores/in-memory-identity-store';
import { InMemoryAuthorityStore } from '../src/stores/json-file-authority-store';
import { InMemoryStatedStore } from '../src/stores/json-file-stated-store';

const WORKSPACE = 'default';

/**
 * A statement that only applies for one week of 2026, so the clock is what
 * decides whether it binds — and the clock is injected, so the boundary is
 * testable rather than something you wait for.
 */
const SEASONAL = {
  kind: 'policy' as const,
  statement: 'Deploys are frozen for the holidays.',
  subject: 'deploy.service',
  effectiveFrom: '2026-12-20T00:00:00.000Z',
  effectiveTo: '2026-12-27T00:00:00.000Z',
  recordedBy: 'alice',
};

describe('OrganizationService', () => {
  let clock: Date;
  let statements: InMemoryStatedStore;
  let grants: InMemoryAuthorityStore;
  let service: OrganizationService;
  let token: string;

  beforeEach(async () => {
    clock = new Date('2026-12-22T12:00:00.000Z');
    statements = new InMemoryStatedStore();
    grants = new InMemoryAuthorityStore();

    const identityStore = new InMemoryIdentityStore();
    const auditLog = new InMemoryAuditLog();
    const gateway = new ActionGateway({
      identityStore,
      auditLog,
      approvalStore: new InMemoryApprovalStore(),
      policyEngine: new PolicyEngine([]),
      enforcement: { default: 'enforce' },
    });
    const registered = await gateway.registerAgent('deploy-bot', 'custom');
    token = registered.token;

    const deps: OrganizationServiceDeps = {
      gateway,
      statements,
      grants,
      decisions: new DecisionMemoryService({
        store: new InMemoryDecisionStore(),
        auditEvents: () => auditLog.query({}),
      }),
      now: () => clock,
      newId: () => 'stated-1',
    };
    service = new OrganizationService(deps);
  });

  const evaluateDeploy = async (): Promise<string[]> => {
    const agent = await service.resolveAgent(token);
    if (agent === null) throw new Error('the test agent should resolve');
    const answer = await service.evaluate(token, agent, { action: 'deploy.service' });
    return answer.constraints;
  };

  it('applies a statement inside its effective window', async () => {
    await service.record(WORKSPACE, SEASONAL);

    expect(await evaluateDeploy()).toEqual(['Deploys are frozen for the holidays.']);
  });

  it('does not apply it before it takes effect', async () => {
    await service.record(WORKSPACE, SEASONAL);
    clock = new Date('2026-12-19T23:59:59.000Z');

    expect(await evaluateDeploy()).toEqual([]);
  });

  it('stops applying it the moment it lapses', async () => {
    await service.record(WORKSPACE, SEASONAL);
    clock = new Date('2026-12-27T00:00:00.000Z');

    expect(await evaluateDeploy()).toEqual([]);
  });

  it('scopes a workspace to itself', async () => {
    await service.record('somebody-else', SEASONAL);

    expect(await evaluateDeploy()).toEqual([]);
    expect(await service.listStatements(WORKSPACE)).toEqual([]);
    expect(await service.listStatements('somebody-else')).toHaveLength(1);
  });

  it('will not verify a statement from another workspace', async () => {
    await service.record('somebody-else', SEASONAL);

    expect(await service.verify(WORKSPACE, 'stated-1', 'alice')).toBeNull();
  });

  it('files only the candidates belonging to the workspace it was given', async () => {
    const stored: ProposeResult = await service.propose(WORKSPACE, [
      { ...candidate('mine'), workspaceId: WORKSPACE },
      { ...candidate('theirs'), workspaceId: 'somebody-else' },
    ]);

    expect(stored).toEqual({ stored: 1, duplicates: 0 });
    expect(await statements.list(WORKSPACE)).toHaveLength(1);
  });

  it('revokes a delegation', async () => {
    const grant = await service.delegate(WORKSPACE, {
      principal: 'alice',
      actions: ['expense.approve'],
      grantedBy: 'alice',
    });

    expect(await service.listGrants(WORKSPACE)).toHaveLength(1);
    expect(await service.revokeGrant(WORKSPACE, grant.id)).toBe(true);
    expect(await service.listGrants(WORKSPACE)).toEqual([]);
    expect(await grants.list(WORKSPACE)).toEqual([]);
  });

  it('will not revoke a delegation belonging to another workspace', async () => {
    const grant = await service.delegate('somebody-else', {
      principal: 'alice',
      actions: ['expense.approve'],
      grantedBy: 'alice',
    });

    expect(await service.revokeGrant(WORKSPACE, grant.id)).toBe(false);
    expect(await service.listGrants('somebody-else')).toHaveLength(1);
  });
});

function candidate(id: string): {
  id: string;
  workspaceId: string;
  kind: 'decision';
  statement: string;
  subject: string;
  provenance: 'observed';
  status: 'candidate';
  version: number;
  evidence: string[];
  confidence: number;
  detectedAt: string;
} {
  return {
    id,
    workspaceId: WORKSPACE,
    kind: 'decision',
    statement: 'Somebody said something.',
    subject: 'topic',
    provenance: 'observed',
    status: 'candidate',
    version: 1,
    evidence: [],
    confidence: 0.9,
    detectedAt: '2026-12-01T00:00:00.000Z',
  };
}
