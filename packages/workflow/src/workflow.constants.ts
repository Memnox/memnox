/** The server publishes the kinds, so the editor cannot draw a shape the engine will not run. */
export const WF_NODE_KIND = {
  TRIGGER: 'trigger',
  CONTEXT: 'context',
  DECISION: 'decision',
  APPROVAL: 'approval',
  DELEGATE: 'delegate',
  BRANCH: 'branch',
  TRANSFORM: 'transform',
  TERMINAL: 'terminal',
} as const;

export type WfNodeKind = (typeof WF_NODE_KIND)[keyof typeof WF_NODE_KIND];

/** The two kinds that count as a gate. Nothing else satisfies the invariant. */
export const GATE_KINDS: readonly WfNodeKind[] = [
  WF_NODE_KIND.DECISION,
  WF_NODE_KIND.APPROVAL,
];

export const RUN_STATE = {
  RUNNING: 'running',
  WAITING: 'waiting',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

export type RunState = (typeof RUN_STATE)[keyof typeof RUN_STATE];

export const STEP_STATE = {
  PENDING: 'pending',
  RUNNING: 'running',
  WAITING: 'waiting',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

export type StepState = (typeof STEP_STATE)[keyof typeof STEP_STATE];

export const WORKFLOW_REFUSAL = {
  UNGATED_DELEGATION:
    'a delegate node must have a decision or an approval on every path from the trigger',
  NO_TRIGGER: 'a workflow needs a trigger',
  UNKNOWN_NODE: 'an edge names a node that does not exist',
} as const;
