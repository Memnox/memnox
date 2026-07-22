import {
  AGENT_KIND,
  DECISION_EFFECT,
  EFFECT_PRECEDENCE,
  InMemorySessionTaintStore,
} from '@memnox/core';
import type { DecisionEffect } from '@memnox/core';
import { ContentShieldAdvisor } from '@memnox/content-shield';
import {
  DECISION_ENFORCEMENT,
  DecisionMemoryAdvisor,
  InMemoryDecisionStore,
} from '@memnox/memory';
import { PolicyEngine, validatePolicyDocument } from '@memnox/policy-engine';
import { TaintAdvisor } from '@memnox/risk';
import {
  ActionGateway,
  InMemoryApprovalStore,
  InMemoryAuditLog,
  InMemoryIdentityStore,
} from '@memnox/runtime';
import { BENCH_SCENARIOS, TAINT_SEED_REQUEST, type BenchScenario } from './scenarios';

export interface BenchResult {
  scenario: BenchScenario;
  actual: DecisionEffect;
  passed: boolean;
}

export interface BenchReport {
  total: number;
  passed: number;
  score: number;
  results: BenchResult[];
}

const BENCH_POLICIES = validatePolicyDocument({
  version: 1,
  policies: [
    {
      name: 'production-database-protection',
      match: {
        actions: ['database.delete', 'database.drop'],
        environments: ['production'],
      },
      decision: { effect: 'block', reason: 'no destructive db ops in production' },
    },
    {
      name: 'destructive-shell-protection',
      match: { actions: ['shell.execute'], targets: ['*drop table*', '*rm -rf /*'] },
      decision: { effect: 'block', reason: 'destructive shell commands are blocked' },
    },
    {
      name: 'production-deploy-approval',
      match: { actions: ['deploy.*'], environments: ['production'] },
      decision: { effect: 'require_approval', approvers: ['eng-lead'] },
    },
    {
      name: 'payment-code-approval',
      match: { actions: ['code.modify'], targets: ['payment/*'] },
      decision: { effect: 'require_approval', approvers: ['security-team'] },
    },
    {
      name: 'customer-data-export-block',
      match: { actions: ['data.export'], targets: ['customers*'] },
      decision: { effect: 'block', reason: 'no agent-initiated customer exports' },
    },
  ],
}).policies;

/** Runs every scenario against a reference gateway built from the open packages. */
export async function runBench(): Promise<BenchReport> {
  const auditLog = new InMemoryAuditLog();
  const decisionStore = new InMemoryDecisionStore();
  await decisionStore.save({
    id: 'bench-decision',
    title: 'No database migration before Q4',
    statement: 'Do not migrate the database before Q4.',
    owner: 'CTO',
    decidedAt: new Date().toISOString(),
    actions: ['database.migrate'],
    enforcement: DECISION_ENFORCEMENT.BLOCK,
  });

  const gateway = new ActionGateway({
    identityStore: new InMemoryIdentityStore(),
    auditLog,
    approvalStore: new InMemoryApprovalStore(),
    policyEngine: new PolicyEngine(BENCH_POLICIES),
    advisors: [
      new ContentShieldAdvisor(),
      new TaintAdvisor(new InMemorySessionTaintStore()),
      new DecisionMemoryAdvisor(decisionStore, ['team-lead']),
    ],
  });
  const { token } = await gateway.registerAgent('bench-agent', AGENT_KIND.CUSTOM);

  // Seed the tainted session so the persistence scenario is meaningful.
  await gateway.authorize(token, TAINT_SEED_REQUEST);

  const results: BenchResult[] = [];
  for (const scenario of BENCH_SCENARIOS) {
    const decision = await gateway.authorize(token, scenario.request);
    const passed = satisfies(decision.effect, scenario.expectedAtLeast);
    results.push({ scenario, actual: decision.effect, passed });
  }
  const passed = results.filter((result) => result.passed).length;
  return {
    total: results.length,
    passed,
    score: Math.round((passed / results.length) * 100),
    results,
  };
}

/** "At least as restrictive": expecting require_approval accepts block; expecting allow accepts anything allowed. */
function satisfies(actual: DecisionEffect, expected: DecisionEffect): boolean {
  if (expected === DECISION_EFFECT.ALLOW) return actual === DECISION_EFFECT.ALLOW;
  return EFFECT_PRECEDENCE[actual] >= EFFECT_PRECEDENCE[expected];
}
