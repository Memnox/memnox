import type { CapabilityUsage, UnusedGrant } from './usage';

/**
 * A proposal generated in a private format is a black box nobody adopts, so this is
 * the same YAML a person would write: readable, editable, committable, diffable.
 */
export interface LeastPrivilegeProposal {
  agentId: string;
  allow: string[];
  requireApproval: string[];
  deny: string[];
  /** State the window and the coverage where they cannot be dropped in the retelling. */
  derivedFrom: {
    windowDays: number;
    actions: number;
    sessions: number;
    /** Share of this agent's traffic the window actually saw, 0 to 1. */
    coverage: number;
  };
  diffAgainst?: string;
}

export interface ProposalInput {
  agentId: string;
  usage: readonly CapabilityUsage[];
  unused: readonly UnusedGrant[];
  windowDays: number;
  sessions: number;
  coverage: number;
  /** Actions that stay behind a person however often they were used. */
  alwaysAsk?: readonly string[];
}

export function proposeLeastPrivilege(input: ProposalInput): LeastPrivilegeProposal {
  const alwaysAsk = new Set(input.alwaysAsk ?? []);
  const used = input.usage.filter((each) => each.agentId === input.agentId);
  const allow: string[] = [];
  const requireApproval: string[] = [];

  for (const usage of used) {
    if (alwaysAsk.has(usage.action)) requireApproval.push(usage.action);
    else allow.push(usage.action);
  }

  const deny = input.unused
    .filter((grant) => grant.agentId === input.agentId)
    .map((grant) => grant.action);

  return {
    agentId: input.agentId,
    allow: unique(allow),
    requireApproval: unique(requireApproval),
    deny: unique(deny),
    derivedFrom: {
      windowDays: input.windowDays,
      actions: used.length,
      sessions: input.sessions,
      coverage: input.coverage,
    },
  };
}

/**
 * Rendered as a policy file in the format a person writes, with the sample size in a
 * comment: four days of one developer's work is not a policy for a team, and a proposal
 * that hides how little it saw is a trap.
 */
export function renderProposal(proposal: LeastPrivilegeProposal): string {
  const { derivedFrom } = proposal;
  const lines = [
    `# Proposed from ${derivedFrom.windowDays} day(s), ${derivedFrom.sessions} session(s),`,
    `# ${derivedFrom.actions} distinct action(s), covering ${Math.round(derivedFrom.coverage * 100)}% of this agent's traffic.`,
    '# Read it, edit it, then apply it. It is a proposal, not a policy.',
    'version: 1',
    'policies:',
  ];

  if (proposal.allow.length > 0) {
    lines.push(
      `  - name: ${proposal.agentId}-observed-allow`,
      '    match:',
      `      agents: ["${proposal.agentId}"]`,
      `      actions: [${quoteAll(proposal.allow)}]`,
      '    decision:',
      '      effect: allow',
      '      reason: "Observed in the window above."',
    );
  }
  if (proposal.requireApproval.length > 0) {
    lines.push(
      `  - name: ${proposal.agentId}-ask-first`,
      '    match:',
      `      agents: ["${proposal.agentId}"]`,
      `      actions: [${quoteAll(proposal.requireApproval)}]`,
      '    decision:',
      '      effect: escalate',
      '      approvers: ["you"]',
      '      reason: "Used, but not without a person."',
    );
  }
  if (proposal.deny.length > 0) {
    lines.push(
      `  - name: ${proposal.agentId}-never-used`,
      '    match:',
      `      agents: ["${proposal.agentId}"]`,
      `      actions: [${quoteAll(proposal.deny)}]`,
      '    decision:',
      '      effect: withhold',
      `      reason: "Granted and never used in ${derivedFrom.windowDays} day(s)."`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function quoteAll(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(', ');
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
