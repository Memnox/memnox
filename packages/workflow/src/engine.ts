import type { Briefing } from './briefing';
import type { Run, Step, WfNode, Workflow } from './workflow';
import { isValid } from './workflow';
import {
  RUN_STATE,
  STEP_STATE,
  WF_NODE_KIND,
  WORKFLOW_REFUSAL,
  type RunState,
} from './workflow.constants';

export interface RunStore {
  saveRun(run: Run): Promise<void>;
  findRun(id: string): Promise<Run | null>;
  saveStep(step: Step): Promise<void>;
  stepsFor(runId: string): Promise<Step[]>;
  /** Every run parked on this key, so a resolution wakes exactly what waited on it. */
  runsWaitingOn(wakeKey: string): Promise<Run[]>;
}

/** What the engine asks the outside world to do. It never does the work itself. */
export interface EngineGateway {
  /** A decision node: the ordinary evaluate call, from a different caller. */
  decide(node: WfNode, run: Run): Promise<{ decisionId: string; allowed: boolean }>;
  /** An approval node: raise the question and hand back the key it will wake on. */
  raise(node: WfNode, run: Run): Promise<{ approvalId: string; wakeKey: string }>;
  /** A delegate node: post the briefing and park until the callback arrives. */
  dispatch(briefing: Briefing, node: WfNode, run: Run): Promise<{ wakeKey: string }>;
  /** Built from the node's config plus a lease; the engine holds no credential itself. */
  brief(node: WfNode, run: Run, stepId: string): Promise<Briefing>;
}

export interface EngineDeps {
  runs: RunStore;
  gateway: EngineGateway;
  newId: () => string;
  clock: () => Date;
}

export const ENGINE_REFUSAL = {
  INVALID_WORKFLOW: WORKFLOW_REFUSAL.UNGATED_DELEGATION,
  UNKNOWN_RUN: 'no such run',
} as const;

export type StartOutcome =
  { started: true; run: Run } | { started: false; reason: string };

/**
 * Durable and resumable. A step row is written as pending before anything happens, and
 * the only durable state is the step table: a run waiting three days on a person has to
 * survive a deployment, and one kept in process would not.
 */
export class WorkflowEngine {
  constructor(private readonly deps: EngineDeps) {}

  async start(
    workflow: Workflow,
    triggerEvent: string,
    correlationId: string,
  ): Promise<StartOutcome> {
    // The server enforces the gate invariant regardless of what the editor drew.
    if (!isValid(workflow)) {
      return { started: false, reason: ENGINE_REFUSAL.INVALID_WORKFLOW };
    }

    const run: Run = {
      id: this.deps.newId(),
      workflowId: workflow.id,
      // Pinned at start, so publishing a change never mutates a run in flight.
      workflowVersion: workflow.version,
      workspaceId: workflow.workspaceId,
      triggerEvent,
      correlationId,
      state: RUN_STATE.RUNNING,
      startedAt: this.deps.clock().toISOString(),
    };
    await this.deps.runs.saveRun(run);
    return { started: true, run: await this.advance(workflow, run) };
  }

  /** Resolution signals the wake key; the engine reloads from rows and continues. */
  async wake(workflow: Workflow, wakeKey: string): Promise<Run[]> {
    const waiting = await this.deps.runs.runsWaitingOn(wakeKey);
    const resumed: Run[] = [];
    for (const run of waiting) {
      const steps = await this.deps.runs.stepsFor(run.id);
      const parked = steps.find((step) => step.wakeKey === wakeKey);
      if (parked !== undefined) {
        await this.deps.runs.saveStep({
          ...parked,
          state: STEP_STATE.DONE,
          endedAt: this.deps.clock().toISOString(),
        });
      }
      resumed.push(await this.advance(workflow, { ...run, state: RUN_STATE.RUNNING }));
    }
    return resumed;
  }

  /**
   * One node at a time, each written before it runs. Execution is keyed by run, node
   * and attempt, so a retry after a timeout cannot double-send.
   */
  private async advance(workflow: Workflow, run: Run): Promise<Run> {
    let current = run;
    for (;;) {
      const node = this.nextNode(workflow, current);
      if (node === undefined) return this.finish(current, RUN_STATE.DONE);
      if (node.kind === WF_NODE_KIND.TERMINAL) {
        await this.recordStep(current, node, STEP_STATE.DONE);
        return this.finish({ ...current, cursor: node.id }, RUN_STATE.DONE);
      }

      const step = await this.recordStep(current, node, STEP_STATE.RUNNING);
      const outcome = await this.run(node, current, step);
      current = { ...current, cursor: node.id };

      if (outcome.parked) {
        await this.deps.runs.saveStep({
          ...step,
          state: STEP_STATE.WAITING,
          wakeKey: outcome.wakeKey,
        });
        return this.finish(current, RUN_STATE.WAITING);
      }
      await this.deps.runs.saveStep({
        ...step,
        state: outcome.failed ? STEP_STATE.FAILED : STEP_STATE.DONE,
        endedAt: this.deps.clock().toISOString(),
        ...(outcome.decisionId === undefined ? {} : { decisionId: outcome.decisionId }),
      });
      if (outcome.failed) return this.finish(current, RUN_STATE.FAILED);
    }
  }

  private async run(
    node: WfNode,
    run: Run,
    step: Step,
  ): Promise<{
    parked: boolean;
    wakeKey?: string;
    failed?: boolean;
    decisionId?: string;
  }> {
    if (node.kind === WF_NODE_KIND.DECISION) {
      const verdict = await this.deps.gateway.decide(node, run);
      // A decision that did not allow stops the run: it is a gate, not a note.
      return { parked: false, failed: !verdict.allowed, decisionId: verdict.decisionId };
    }
    if (node.kind === WF_NODE_KIND.APPROVAL) {
      const raised = await this.deps.gateway.raise(node, run);
      return { parked: true, wakeKey: raised.wakeKey };
    }
    if (node.kind === WF_NODE_KIND.DELEGATE) {
      const briefing = await this.deps.gateway.brief(node, run, step.id);
      const dispatched = await this.deps.gateway.dispatch(briefing, node, run);
      return { parked: true, wakeKey: dispatched.wakeKey };
    }
    // Trigger, context, branch and transform carry no gate and no outside call.
    return { parked: false };
  }

  private nextNode(workflow: Workflow, run: Run): WfNode | undefined {
    if (run.cursor === undefined) {
      return workflow.nodes.find((node) => node.kind === WF_NODE_KIND.TRIGGER);
    }
    const edge = workflow.edges.find((each) => each.from === run.cursor);
    if (edge === undefined) return undefined;
    return workflow.nodes.find((node) => node.id === edge.to);
  }

  private async recordStep(run: Run, node: WfNode, state: Step['state']): Promise<Step> {
    const steps = await this.deps.runs.stepsFor(run.id);
    const attempt = steps.filter((step) => step.nodeId === node.id).length + 1;
    const step: Step = {
      id: `${run.id}:${node.id}:${attempt}`,
      runId: run.id,
      nodeId: node.id,
      attempt,
      state,
      startedAt: this.deps.clock().toISOString(),
    };
    // Written as pending before anything happens: a step that existed only in memory
    // would vanish on a restart, and the work it stood for would vanish with it.
    await this.deps.runs.saveStep(step);
    return step;
  }

  private async finish(run: Run, state: RunState): Promise<Run> {
    const finished = { ...run, state };
    await this.deps.runs.saveRun(finished);
    return finished;
  }
}
