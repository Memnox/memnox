import type { DecisionEffect } from '../constants/decision.constants';
import type { EnforcementMode } from '../constants/enforcement.constants';
import type { ToolClass } from '../discovery/classify';
import type { Alternative } from '../domain/decision';

/**
 * One thing an agent tried to do, and what happened to it. This is the row every
 * surface writes and every later question is answered from, so it is versioned and
 * frozen: the cloud reads it, and a field that changed meaning would corrupt history
 * nobody can go back and re-derive.
 */
export const EVENT_SCHEMA_VERSION = 1;

/** Where the attempt was caught. One per interception point the product ships. */
export const EVENT_SURFACE = {
  MCP: 'mcp',
  SHELL: 'shell',
  GIT: 'git',
  FILESYSTEM: 'filesystem',
  NETWORK: 'network',
  /** A question somebody asked; recorded so `why` can answer about it later. */
  QUESTION: 'question',
} as const;

export type EventSurface = (typeof EVENT_SURFACE)[keyof typeof EVENT_SURFACE];

/** Who was behind the attempt. Human actions on this machine are recorded too. */
export const ACTOR_TYPE = {
  AGENT: 'agent',
  HUMAN: 'human',
  /** A pipeline or service token, which is neither and behaves like both. */
  AUTOMATION: 'automation',
} as const;

export type ActorType = (typeof ACTOR_TYPE)[keyof typeof ACTOR_TYPE];

/** How an attempt ended once it was allowed to run. */
export const EXECUTION = {
  /** Allowed and completed. */
  COMPLETED: 'completed',
  /** Allowed and the process reported failure. Not a governance outcome. */
  FAILED: 'failed',
  /** Never ran, because the verdict stopped it. */
  BLOCKED: 'blocked',
  /** Held for a person and nobody answered in time. */
  TIMED_OUT: 'timed-out',
} as const;

export type Execution = (typeof EXECUTION)[keyof typeof EXECUTION];

/**
 * The rule that decided, named well enough to open the file and read the line. The
 * decision's own `RuleRef` identifies a rule; this one locates it, which is what
 * `memnox why` has to print.
 */
export interface EventRuleRef {
  name: string;
  /** Which layer it came from: org, user or project. */
  layer: string;
  file: string;
  line?: number;
}

export interface MemnoxEvent {
  /** Stable across a resend, so the cloud can dedupe on it. */
  id: string;
  schemaVersion: number;
  /** ISO 8601. Supplied by the caller so a replay is reproducible. */
  at: string;

  sessionId: string;
  /** The product, e.g. "claude-code". Never a credential. */
  agent: string;
  actorType: ActorType;
  /** The person whose authority this ran under, where one is known. */
  principal?: string;

  surface: EventSurface;
  /** What was attempted, e.g. "github.merge_pull_request" or "rm". */
  operation: string;
  /** What it operated on, e.g. a path, a branch, a host. Never a payload. */
  target?: string;
  class: ToolClass;

  effect: DecisionEffect;
  /** What enforce would have said, when the mode kept it from being applied. */
  shadowEffect?: DecisionEffect;
  mode: EnforcementMode;
  reason: string;
  rule?: EventRuleRef;
  /** Resolved from the rule that denied. Never invented. */
  alternative?: Alternative;

  /**
   * Content hash of the rule set in force when this was decided, so `why` can say
   * what the rules were then rather than what they are now.
   */
  policyHash?: string;

  /**
   * The workspace bundle this machine was running when it decided.
   *
   * `policyHash` covers the whole stack as this machine assembled it, which is not a
   * thing the control plane can name. Without this a verdict cannot be replayed
   * against what the workspace had published at the time, and "was this machine even
   * on the current rules" is unanswerable after the fact.
   */
  bundleHash?: string;

  /**
   * Ids of the conditions in force at the moment of the verdict.
   *
   * The engine computed a state version for every decision and nothing carried it to
   * the ledger, so the field that exists to make a freeze visible afterwards was
   * stamped and dropped. Recorded as ids rather than labels because the label is
   * derivable from them and the id is what a condition is actually called.
   */
  conditionsInForce?: readonly string[];

  /** A hash of the arguments. The arguments themselves never reach a row. */
  argsDigest?: string;

  execution?: Execution;
  exitCode?: number;
  durationMs?: number;
  /** A hash of what the command printed. Never the output. */
  outputDigest?: string;

  /** Who released a held call, once somebody did. */
  authorizedBy?: string;

  /**
   * What this action cost, in dollars, when something reported it.
   *
   * Memnox prices nothing: an MCP call's model spend is knowable to the agent and to
   * nobody else on this machine, so a number invented here would be the one figure a
   * reader stops trusting the rest of the row over. Absent means nobody said, which is
   * a different answer from zero and is why a dollar budget reads as unwatched rather
   * than as under budget.
   */
  costUsd?: number;
}

/**
 * The one thing every surface writes through. Append-only by contract: a sink that
 * updated a row would make the record a claim about the past rather than the past.
 */
export interface EventSink {
  append(event: MemnoxEvent): Promise<void>;
  /** Chronological. Callers on a hot path must pass a limit. */
  query(filter: EventQuery): Promise<MemnoxEvent[]>;
}

export interface EventQuery {
  sessionId?: string;
  agent?: string;
  surface?: EventSurface;
  /** Only these effects, e.g. everything that was not an allow. */
  effects?: readonly DecisionEffect[];
  since?: string;
  until?: string;
  limit?: number;
}

export function matches(row: MemnoxEvent, filter: EventQuery): boolean {
  if (filter.sessionId !== undefined && row.sessionId !== filter.sessionId) return false;
  if (filter.agent !== undefined && row.agent !== filter.agent) return false;
  if (filter.surface !== undefined && row.surface !== filter.surface) return false;
  if (filter.effects !== undefined && !filter.effects.includes(row.effect)) return false;
  if (filter.since !== undefined && row.at < filter.since) return false;
  if (filter.until !== undefined && row.at > filter.until) return false;
  return true;
}
