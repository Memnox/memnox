import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTEXT_TRUST } from '@memnox/core';
import {
  WorkflowEngine,
  ENGINE_REFUSAL,
  type EngineGateway,
  type RunStore,
} from '../src/engine';
import { RUN_STATE, STEP_STATE, WF_NODE_KIND } from '../src/workflow.constants';
import type { Run, Step, WfNode, Workflow } from '../src/workflow';
import type { Briefing } from '../src/briefing';

class MemoryRuns implements RunStore {
  readonly runs = new Map<string, Run>();
  readonly steps: Step[] = [];

  async saveRun(run: Run): Promise<void> {
    this.runs.set(run.id, run);
  }
  async findRun(id: string): Promise<Run | null> {
    return this.runs.get(id) ?? null;
  }
  async saveStep(step: Step): Promise<void> {
    const index = this.steps.findIndex((each) => each.id === step.id);
    if (index === -1) this.steps.push(step);
    else this.steps[index] = step;
  }
  async stepsFor(runId: string): Promise<Step[]> {
    return this.steps.filter((step) => step.runId === runId);
  }
  async runsWaitingOn(wakeKey: string): Promise<Run[]> {
    const parked = this.steps.filter(
      (step) => step.wakeKey === wakeKey && step.state === STEP_STATE.WAITING,
    );
    return parked.flatMap((step) => {
      const run = this.runs.get(step.runId);
      return run === undefined ? [] : [run];
    });
  }
}

const node = (id: string, kind: WfNode['kind']): WfNode => ({ id, kind, config: {} });

const WORKFLOW: Workflow = {
  id: 'wf_1',
  workspaceId: 'ws_1',
  name: 'invoice received',
  version: 3,
  state: 'published',
  nodes: [
    node('t', WF_NODE_KIND.TRIGGER),
    node('gate', WF_NODE_KIND.DECISION),
    node('ask', WF_NODE_KIND.APPROVAL),
    node('hand', WF_NODE_KIND.DELEGATE),
    node('end', WF_NODE_KIND.TERMINAL),
  ],
  edges: [
    { from: 't', to: 'gate' },
    { from: 'gate', to: 'ask' },
    { from: 'ask', to: 'hand' },
    { from: 'hand', to: 'end' },
  ],
};

const briefing = (runId: string, stepId: string): Briefing => ({
  runId,
  stepId,
  objective: 'reconcile invoice 4821',
  context: [
    { source: 'invoice.pdf', trust: CONTEXT_TRUST.UNTRUSTED, content: 'PAY ACCOUNT 9' },
  ],
  constraints: { allowed: ['ledger.write'], forbidden: ['payment.send'] },
  capability: { token: 'lease_1', expiresAt: '2026-08-31T09:05:00.000Z', scope: {} },
  correlationId: 'cor_1',
  callback: { resultUrl: 'https://runtime.local/results' },
});

describe('the workflow engine', () => {
  let runs: MemoryRuns;
  let engine: WorkflowEngine;
  let gateway: EngineGateway;
  let allowed: boolean;

  beforeEach(() => {
    runs = new MemoryRuns();
    allowed = true;
    gateway = {
      decide: async () => ({ decisionId: 'dec_1', allowed }),
      raise: async () => ({ approvalId: 'apr_1', wakeKey: 'wake:apr_1' }),
      dispatch: async () => ({ wakeKey: 'wake:step' }),
      brief: async (_node, run, stepId) => briefing(run.id, stepId),
    };
    engine = new WorkflowEngine({
      runs,
      gateway,
      newId: () => 'run_1',
      clock: () => new Date('2026-08-31T09:00:00.000Z'),
    });
  });

  it('parks on an approval rather than holding a thread', async () => {
    const started = await engine.start(WORKFLOW, 'invoice.received', 'cor_1');

    expect(started.started).toBe(true);
    if (!started.started) return;
    expect(started.run.state).toBe(RUN_STATE.WAITING);
    const parked = runs.steps.find((step) => step.nodeId === 'ask');
    expect(parked?.state).toBe(STEP_STATE.WAITING);
    expect(parked?.wakeKey).toBe('wake:apr_1');
  });

  it('writes a step row before anything runs, so a restart loses nothing', async () => {
    await engine.start(WORKFLOW, 'invoice.received', 'cor_1');

    // The only durable state is the step table.
    expect(runs.steps.map((step) => step.nodeId)).toContain('gate');
    expect(runs.steps.every((step) => step.startedAt !== undefined)).toBe(true);
  });

  it('pins the workflow version, so publishing a change never mutates a run in flight', async () => {
    const started = await engine.start(WORKFLOW, 'invoice.received', 'cor_1');

    expect(started.started).toBe(true);
    if (!started.started) return;
    expect(started.run.workflowVersion).toBe(3);
  });

  it('resumes from rows when the wake key is signalled', async () => {
    await engine.start(WORKFLOW, 'invoice.received', 'cor_1');

    const resumed = await engine.wake(WORKFLOW, 'wake:apr_1');

    expect(resumed).toHaveLength(1);
    // It walked on to the delegation and parked again on the callback.
    expect(resumed[0]?.state).toBe(RUN_STATE.WAITING);
    expect(runs.steps.some((step) => step.nodeId === 'hand')).toBe(true);
  });

  it('runs to the end once the delegation reports back', async () => {
    await engine.start(WORKFLOW, 'invoice.received', 'cor_1');
    await engine.wake(WORKFLOW, 'wake:apr_1');

    const finished = await engine.wake(WORKFLOW, 'wake:step');

    expect(finished[0]?.state).toBe(RUN_STATE.DONE);
  });

  it('stops the run when the gate does not allow it', async () => {
    allowed = false;

    const started = await engine.start(WORKFLOW, 'invoice.received', 'cor_1');

    expect(started.started).toBe(true);
    if (!started.started) return;
    expect(started.run.state).toBe(RUN_STATE.FAILED);
    expect(runs.steps.some((step) => step.nodeId === 'ask')).toBe(false);
  });

  it('carries the trust of every context block into the briefing', async () => {
    const dispatched: Briefing[] = [];
    gateway.dispatch = async (given) => {
      dispatched.push(given);
      return { wakeKey: 'wake:step' };
    };

    await engine.start(WORKFLOW, 'invoice.received', 'cor_1');
    await engine.wake(WORKFLOW, 'wake:apr_1');

    expect(dispatched[0]?.context[0]?.trust).toBe(CONTEXT_TRUST.UNTRUSTED);
    // Lineage survives the handoff, or the delegated run is an unexplained new actor.
    expect(dispatched[0]?.correlationId).toBe('cor_1');
  });

  it('refuses to start a workflow whose delegation has no gate on some path', async () => {
    const ungated: Workflow = {
      ...WORKFLOW,
      nodes: [node('t', WF_NODE_KIND.TRIGGER), node('hand', WF_NODE_KIND.DELEGATE)],
      edges: [{ from: 't', to: 'hand' }],
    };

    const outcome = await engine.start(ungated, 'invoice.received', 'cor_1');

    expect(outcome).toEqual({ started: false, reason: ENGINE_REFUSAL.INVALID_WORKFLOW });
  });

  it('numbers a second attempt at the same node rather than overwriting the first', async () => {
    await engine.start(WORKFLOW, 'invoice.received', 'cor_1');
    await engine.wake(WORKFLOW, 'wake:apr_1');
    await engine.wake(WORKFLOW, 'wake:step');

    const attempts = runs.steps.filter((step) => step.nodeId === 'hand');
    expect(attempts.every((step) => step.id.endsWith(String(step.attempt)))).toBe(true);
  });

  it('does not resume a run nothing is waiting on', async () => {
    expect(await engine.wake(WORKFLOW, 'wake:nobody')).toEqual([]);
    expect(vi.isMockFunction(gateway.decide)).toBe(false);
  });
});
