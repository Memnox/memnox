import { describe, expect, it } from 'vitest';
import { CONTEXT_TRUST } from '@memnox/core';
import { WF_NODE_KIND, WORKFLOW_REFUSAL } from '../src/workflow.constants';
import {
  isValid,
  validateWorkflow,
  type WfEdge,
  type WfNode,
  type Workflow,
} from '../src/workflow';
import { isWellFormed, type Briefing } from '../src/briefing';

const node = (id: string, kind: WfNode['kind']): WfNode => ({ id, kind, config: {} });

function workflow(nodes: WfNode[], edges: WfEdge[]): Workflow {
  return {
    id: 'wf_1',
    workspaceId: 'ws_1',
    name: 'invoice received',
    version: 1,
    state: 'draft',
    nodes,
    edges,
  };
}

describe('the invariant: every route to a delegation passes a gate', () => {
  it('refuses a delegation reached straight from the trigger', () => {
    const invalid = workflow(
      [node('t', WF_NODE_KIND.TRIGGER), node('d', WF_NODE_KIND.DELEGATE)],
      [{ from: 't', to: 'd' }],
    );

    expect(validateWorkflow(invalid)).toContainEqual({
      nodeId: 'd',
      reason: WORKFLOW_REFUSAL.UNGATED_DELEGATION,
    });
  });

  it('accepts one with a decision on the way', () => {
    const valid = workflow(
      [
        node('t', WF_NODE_KIND.TRIGGER),
        node('g', WF_NODE_KIND.DECISION),
        node('d', WF_NODE_KIND.DELEGATE),
      ],
      [
        { from: 't', to: 'g' },
        { from: 'g', to: 'd' },
      ],
    );

    expect(isValid(valid)).toBe(true);
  });

  it('accepts an approval as the gate too', () => {
    const valid = workflow(
      [
        node('t', WF_NODE_KIND.TRIGGER),
        node('a', WF_NODE_KIND.APPROVAL),
        node('d', WF_NODE_KIND.DELEGATE),
      ],
      [
        { from: 't', to: 'a' },
        { from: 'a', to: 'd' },
      ],
    );

    expect(isValid(valid)).toBe(true);
  });

  it('refuses when one branch of two carries no gate', () => {
    // The whole point of walking every path: a gated happy path proves nothing about
    // the branch somebody added underneath it later.
    const invalid = workflow(
      [
        node('t', WF_NODE_KIND.TRIGGER),
        node('b', WF_NODE_KIND.BRANCH),
        node('g', WF_NODE_KIND.DECISION),
        node('d', WF_NODE_KIND.DELEGATE),
      ],
      [
        { from: 't', to: 'b' },
        { from: 'b', to: 'g' },
        { from: 'g', to: 'd' },
        { from: 'b', to: 'd' },
      ],
    );

    expect(isValid(invalid)).toBe(false);
  });

  it('follows a long ungated chain back to the trigger', () => {
    const invalid = workflow(
      [
        node('t', WF_NODE_KIND.TRIGGER),
        node('c', WF_NODE_KIND.CONTEXT),
        node('x', WF_NODE_KIND.TRANSFORM),
        node('d', WF_NODE_KIND.DELEGATE),
      ],
      [
        { from: 't', to: 'c' },
        { from: 'c', to: 'x' },
        { from: 'x', to: 'd' },
      ],
    );

    expect(isValid(invalid)).toBe(false);
  });

  it('does not mistake a cycle for an escape to the trigger', () => {
    const valid = workflow(
      [
        node('t', WF_NODE_KIND.TRIGGER),
        node('g', WF_NODE_KIND.DECISION),
        node('x', WF_NODE_KIND.TRANSFORM),
        node('d', WF_NODE_KIND.DELEGATE),
      ],
      [
        { from: 't', to: 'g' },
        { from: 'g', to: 'x' },
        { from: 'x', to: 'd' },
        { from: 'd', to: 'x' },
      ],
    );

    expect(isValid(valid)).toBe(true);
  });

  it('refuses a workflow with no trigger at all', () => {
    const invalid = workflow([node('g', WF_NODE_KIND.DECISION)], []);

    expect(validateWorkflow(invalid)).toContainEqual({
      reason: WORKFLOW_REFUSAL.NO_TRIGGER,
    });
  });
});

describe('the briefing', () => {
  const briefing: Briefing = {
    runId: 'run_1',
    stepId: 'step_1',
    objective: 'reconcile invoice 4821',
    context: [
      {
        source: 'invoice.pdf',
        trust: CONTEXT_TRUST.UNTRUSTED,
        content: 'PAY TO ACCOUNT 9',
      },
    ],
    constraints: { allowed: ['ledger.write'], forbidden: ['payment.send'] },
    capability: { token: 'lease_1', expiresAt: '2026-08-31T09:05:00.000Z', scope: {} },
    correlationId: 'cor_1',
    callback: { resultUrl: 'https://runtime.local/results' },
  };

  it('carries the trust level of every block across the handoff', () => {
    expect(briefing.context[0]?.trust).toBe(CONTEXT_TRUST.UNTRUSTED);
    expect(isWellFormed(briefing)).toBe(true);
  });

  it('is not well formed without a capability, because a key is not an alternative', () => {
    expect(
      isWellFormed({ ...briefing, capability: { ...briefing.capability, token: '' } }),
    ).toBe(false);
  });

  it('is not well formed without a correlation id, or lineage stops at the handoff', () => {
    expect(isWellFormed({ ...briefing, correlationId: '' })).toBe(false);
  });
});
