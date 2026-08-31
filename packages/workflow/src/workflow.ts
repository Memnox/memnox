import type { RunState, StepState, WfNodeKind } from './workflow.constants';
import { GATE_KINDS, WF_NODE_KIND, WORKFLOW_REFUSAL } from './workflow.constants';

export interface WfNode {
  id: string;
  kind: WfNodeKind;
  config: Record<string, unknown>;
  position?: { x: number; y: number };
}

export interface WfEdge {
  from: string;
  to: string;
  /** Which branch this edge leaves by, when it leaves a branch node. */
  branch?: string;
}

export interface Workflow {
  id: string;
  workspaceId: string;
  name: string;
  version: number;
  state: 'draft' | 'published' | 'retired';
  nodes: WfNode[];
  edges: WfEdge[];
}

export interface Run {
  id: string;
  workflowId: string;
  /** Pinned at start, so publishing a change never mutates a run in flight. */
  workflowVersion: number;
  workspaceId: string;
  triggerEvent: string;
  correlationId: string;
  state: RunState;
  cursor?: string;
  startedAt: string;
}

export interface Step {
  id: string;
  runId: string;
  nodeId: string;
  attempt: number;
  state: StepState;
  input?: unknown;
  output?: unknown;
  error?: string;
  decisionId?: string;
  approvalId?: string;
  leaseId?: string;
  /** Signalled when the thing this step parked on resolves. */
  wakeKey?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface ValidationIssue {
  nodeId?: string;
  reason: string;
}

/**
 * Every route to a delegation passes a decision or an approval, and one that does not
 * is refused at save. Validation walks backward from every delegate node to the trigger:
 * if any path reaches the trigger without crossing a gate, the workflow cannot exist.
 * The console mirrors this while drawing; the server enforces it regardless.
 */
export function validateWorkflow(workflow: Workflow): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));

  for (const edge of workflow.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) {
      issues.push({ reason: WORKFLOW_REFUSAL.UNKNOWN_NODE });
      break;
    }
  }

  const triggers = workflow.nodes.filter((node) => node.kind === WF_NODE_KIND.TRIGGER);
  if (triggers.length === 0) issues.push({ reason: WORKFLOW_REFUSAL.NO_TRIGGER });

  const incoming = new Map<string, string[]>();
  for (const edge of workflow.edges) {
    const existing = incoming.get(edge.to);
    if (existing === undefined) incoming.set(edge.to, [edge.from]);
    else existing.push(edge.from);
  }

  for (const node of workflow.nodes) {
    if (node.kind !== WF_NODE_KIND.DELEGATE) continue;
    if (reachesTriggerUngated(node.id, byId, incoming, new Set())) {
      issues.push({ nodeId: node.id, reason: WORKFLOW_REFUSAL.UNGATED_DELEGATION });
    }
  }

  return issues;
}

/**
 * True when some path back to a trigger crosses no gate. A cycle is not a path to the
 * trigger, so a node already on the walk is skipped rather than treated as an escape.
 */
function reachesTriggerUngated(
  nodeId: string,
  byId: ReadonlyMap<string, WfNode>,
  incoming: ReadonlyMap<string, string[]>,
  seen: Set<string>,
): boolean {
  if (seen.has(nodeId)) return false;
  seen.add(nodeId);

  const parents = incoming.get(nodeId);
  // A delegate node with nothing upstream is unreachable from any trigger, and an
  // unreachable delegation is not a hole somebody can drive an action through.
  if (parents === undefined || parents.length === 0) return false;

  for (const parentId of parents) {
    const parent = byId.get(parentId);
    if (parent === undefined) continue;
    if (GATE_KINDS.includes(parent.kind)) continue;
    if (parent.kind === WF_NODE_KIND.TRIGGER) return true;
    if (reachesTriggerUngated(parentId, byId, incoming, new Set(seen))) return true;
  }
  return false;
}

export function isValid(workflow: Workflow): boolean {
  return validateWorkflow(workflow).length === 0;
}
