import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT, type ActionRequest, type DecisionEffect } from '@memnox/core';
import { PolicyEngine } from '../src/policy-engine';
import { findPolicyPack } from '../src/policy-packs';
import type { Policy } from '../src/policy';

const AGENT = { agentName: 'claude-code' };

function packEngine(name: string): PolicyEngine {
  const pack = findPolicyPack(name);
  if (pack === null) throw new Error(`pack "${name}" is not shipped`);
  return new PolicyEngine(pack.policies as Policy[]);
}

const decide = (engine: PolicyEngine, request: ActionRequest): DecisionEffect =>
  engine.evaluate(request, AGENT).effect;

describe('model-governance', () => {
  const engine = packEngine('model-governance');

  it('blocks ad-hoc fine-tuned and preview variants', () => {
    expect(decide(engine, { action: 'llm.infer', model: 'ft:gpt-4:acme:custom' })).toBe(
      DECISION_EFFECT.WITHHOLD,
    );
    expect(decide(engine, { action: 'llm.infer', model: 'claude-preview-x' })).toBe(
      DECISION_EFFECT.WITHHOLD,
    );
  });

  it('allows an approved model', () => {
    expect(decide(engine, { action: 'llm.infer', model: 'openai.gpt-4' })).toBe(
      DECISION_EFFECT.ALLOW,
    );
  });

  // A model-scoped rule must not fire on a request that names no model.
  it('stays inert when the request reports no model', () => {
    expect(decide(engine, { action: 'llm.infer' })).toBe(DECISION_EFFECT.ALLOW);
  });
});

describe('provider-governance', () => {
  const engine = packEngine('provider-governance');

  it('escalates an unreviewed provider', () => {
    expect(decide(engine, { action: 'llm.infer', provider: 'replicate' })).toBe(
      DECISION_EFFECT.ESCALATE,
    );
  });

  it('allows a reviewed provider', () => {
    expect(decide(engine, { action: 'llm.infer', provider: 'anthropic' })).toBe(
      DECISION_EFFECT.ALLOW,
    );
  });
});

describe('data-residency', () => {
  const engine = packEngine('data-residency');

  it('blocks EU personal data leaving the EEA', () => {
    expect(
      decide(engine, {
        action: 'data.transfer',
        dataClassification: 'pii.eu',
        jurisdiction: 'us',
      }),
    ).toBe(DECISION_EFFECT.WITHHOLD);
  });

  it('allows EU personal data staying in the EEA', () => {
    expect(
      decide(engine, {
        action: 'data.transfer',
        dataClassification: 'pii.eu',
        jurisdiction: 'eu',
      }),
    ).toBe(DECISION_EFFECT.ALLOW);
  });

  it('blocks HIPAA data leaving US jurisdiction', () => {
    expect(
      decide(engine, {
        action: 'data.transfer',
        dataClassification: 'hipaa',
        jurisdiction: 'eu',
      }),
    ).toBe(DECISION_EFFECT.WITHHOLD);
  });

  // Both dimensions are required; one alone must not trigger a residency block.
  it('stays inert without a classification', () => {
    expect(decide(engine, { action: 'data.transfer', jurisdiction: 'us' })).toBe(
      DECISION_EFFECT.ALLOW,
    );
  });

  it('stays inert without a jurisdiction', () => {
    expect(
      decide(engine, { action: 'data.transfer', dataClassification: 'pii.eu' }),
    ).toBe(DECISION_EFFECT.ALLOW);
  });
});

describe('regulated-data', () => {
  const engine = packEngine('regulated-data');

  it('escalates cardholder and health data', () => {
    expect(decide(engine, { action: 'database.read', dataClassification: 'pci' })).toBe(
      DECISION_EFFECT.ESCALATE,
    );
    expect(decide(engine, { action: 'database.read', dataClassification: 'phi' })).toBe(
      DECISION_EFFECT.ESCALATE,
    );
  });

  // Export is the one verb no approval makes safe — block must win over approval.
  it('blocks export of regulated data even though another rule would escalate', () => {
    expect(decide(engine, { action: 'data.export', dataClassification: 'pci' })).toBe(
      DECISION_EFFECT.WITHHOLD,
    );
  });

  it('stays inert on unclassified requests', () => {
    expect(decide(engine, { action: 'data.export' })).toBe(DECISION_EFFECT.ALLOW);
    expect(decide(engine, { action: 'database.read' })).toBe(DECISION_EFFECT.ALLOW);
  });
});

describe('sovereignty', () => {
  const engine = packEngine('sovereignty');

  it('keeps classified workloads out of non-approved regions', () => {
    expect(
      decide(engine, {
        action: 'llm.infer',
        dataClassification: 'classified',
        jurisdiction: 'global',
      }),
    ).toBe(DECISION_EFFECT.WITHHOLD);
  });

  it('allows a sovereign workload in its own region', () => {
    expect(
      decide(engine, {
        action: 'llm.infer',
        dataClassification: 'classified',
        jurisdiction: 'us-gov',
      }),
    ).toBe(DECISION_EFFECT.ALLOW);
  });
});

describe('money-movement', () => {
  const engine = packEngine('money-movement');

  it('blocks treasury movement outright', () => {
    expect(decide(engine, { action: 'treasury.transfer' })).toBe(
      DECISION_EFFECT.WITHHOLD,
    );
    expect(decide(engine, { action: 'wallet.send' })).toBe(DECISION_EFFECT.WITHHOLD);
  });

  it('escalates refunds and billing changes', () => {
    expect(decide(engine, { action: 'payment.refund' })).toBe(DECISION_EFFECT.ESCALATE);
    expect(decide(engine, { action: 'subscription.cancel' })).toBe(
      DECISION_EFFECT.ESCALATE,
    );
  });
});

describe('agent-chain', () => {
  const engine = packEngine('agent-chain');

  it('blocks an agent escalating its own privileges', () => {
    expect(decide(engine, { action: 'agent.grant_capability' })).toBe(
      DECISION_EFFECT.WITHHOLD,
    );
    expect(decide(engine, { action: 'agent.assume_role' })).toBe(
      DECISION_EFFECT.WITHHOLD,
    );
  });

  it('escalates agent-to-agent messaging', () => {
    expect(decide(engine, { action: 'agent.message' })).toBe(DECISION_EFFECT.ESCALATE);
  });
});

describe('workflow-autonomy', () => {
  const engine = packEngine('workflow-autonomy');

  it('blocks destructive steps inside an unattended chain', () => {
    expect(
      decide(engine, { action: 'workflow.chain', target: 'purge-old-records' }),
    ).toBe(DECISION_EFFECT.WITHHOLD);
  });

  it('escalates starting unattended automation', () => {
    expect(decide(engine, { action: 'workflow.start_unattended' })).toBe(
      DECISION_EFFECT.ESCALATE,
    );
  });

  it('leaves an ordinary chained step alone', () => {
    expect(decide(engine, { action: 'workflow.chain', target: 'send-summary' })).toBe(
      DECISION_EFFECT.ALLOW,
    );
  });
});

describe('executive-approval', () => {
  const engine = packEngine('executive-approval');

  it('requires two signatures, not one', () => {
    const matched = engine.evaluate(
      { action: 'treasury.transfer', environment: 'production' },
      AGENT,
    ).matchedPolicies;

    expect(matched[0]?.minApprovals).toBe(2);
    expect(matched[0]?.approvers).toEqual(['cto', 'ciso', 'cfo']);
  });

  it('applies only in production', () => {
    expect(decide(engine, { action: 'database.drop', environment: 'staging' })).toBe(
      DECISION_EFFECT.ALLOW,
    );
  });
});
