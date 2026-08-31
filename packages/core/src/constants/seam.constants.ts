/** One per agent kind, named and tested. A seam nobody named governs nothing. */
export const SEAM_KIND = {
  MCP_PROXY: 'mcp_proxy',
  HOOK: 'hook',
  SHELL: 'shell',
  GIT: 'git',
  EGRESS: 'egress',
  BROKER: 'broker',
  DOCKER: 'docker',
  REPO_GATE: 'repo_gate',
} as const;

export type SeamKind = (typeof SEAM_KIND)[keyof typeof SEAM_KIND];

/**
 * What a seam cannot see, declared and shown everywhere. A governed agent with an
 * unwatched side channel is worse than an ungoverned one, because somebody believes it.
 */
export const SEAM_BLIND_SPOT = {
  MODEL_REASONING: "the model's reasoning",
  IN_EDITOR_EDITS: 'in-editor edits',
  PROVIDER_SIDE_EXECUTION: 'provider-side execution',
  BEFORE_THE_PR: 'everything before the pull request',
  VENDOR_INTERIOR: 'everything the vendor does',
  UNCREDENTIALED_STEPS: 'steps needing no credential',
} as const;

/**
 * What a seam does when the runtime is unhealthy, chosen per environment rather than
 * globally. Standing on the path makes this a decision somebody has to make, not a default.
 */
export const SEAM_UNHEALTHY = {
  /** The action stops. The safe answer, and the one an unset environment gets. */
  WITHHOLD: 'withhold',
  /** The action proceeds and is recorded as ungoverned. Say so, and say what breaks. */
  PROCEED: 'proceed',
} as const;

export type SeamUnhealthyBehaviour = (typeof SEAM_UNHEALTHY)[keyof typeof SEAM_UNHEALTHY];

export const DEFAULT_SEAM_UNHEALTHY: SeamUnhealthyBehaviour = SEAM_UNHEALTHY.WITHHOLD;
