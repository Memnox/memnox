import type { DecisionEffect } from '../constants/decision.constants';
import type { ActionRequest } from '../domain/action-event';
import type { Alternative, MatchedPolicy } from '../domain/decision';
import { DECISION_EFFECT, EFFECT_PRECEDENCE } from '../constants/decision.constants';
import { PolicyEngine, type Policy } from '../policy/index';
import { matchesAny } from '../policy/pattern-matcher';
import { scopeOf, TASK_INTENT, type SessionTask } from '../session/session-task';
import { reachesOutside } from '../notice/turn';
import { TOOL_CLASS } from '../discovery/classify';
import { SCOPE_MATCH, type ScopeComparison } from '../domain/task';
import { containmentAsk, type Containment, type ContainmentAsk } from './containment';
import { allowanceFor, describeAllowance, type Allowance } from './allowances';
import { selfProtection } from './self-protection';
import type { NoticePort } from '../notice/unusual-notice';
import { loadPolicyFiles, type OptionalPolicySources } from './policy-file';

/**
 * The rules this machine holds, asked one action at a time by the seams. Nothing on this
 * path makes a network call, so an agent stays governed with the wifi off.
 */

const SIGNAL_POLICY_PREFIX = 'policy:';

export interface LocalGateOptions {
  /** Matched against a rule's `agents` patterns, exactly as the runtime does. */
  agentName: string;
  /** The job this agent was enrolled under, so a rule's `roles` has something to match. */
  agentRole?: string;
  /**
   * What somebody asked for, so a rule can match on `scope`. Null is `undeclared` rather
   * than out of scope, because most sessions declare nothing.
   */
  task?: SessionTask | null;
  /** Effect when no rule matches. Defaults to allow, because the runtime is still asked. */
  defaultEffect?: DecisionEffect;
  /** Supplied by the caller so a verdict stays reproducible on replay. */
  now?: Date;
  /** What is in force, handed in, since a gate blind to a freeze lets its one action through. */
  stateFacts?: readonly string[];
  /** The session's repository, and whether it or its agent is on a shorter leash. */
  containment?: Containment;
  /** The agents that started this one, outermost first. Their rules bind it too. */
  parents?: readonly string[];
  /** Scopes a person allowed for a while, which turn an ask inside them into an allow. */
  allowances?: readonly Allowance[] | (() => readonly Allowance[]);
}

export interface LocalVerdict {
  effect: DecisionEffect;
  reason: string;
  /** Findings safe to send onward: rule ids only, never the matched text. */
  signals: string[];
  matchedPolicies: MatchedPolicy[];
  /** What an observed rule would have decided, had it been enforcing. */
  shadowEffect?: DecisionEffect;
  /** Resolved from the rule that denied, never invented, so a refusal is not a dead end. */
  alternative?: Alternative;
  /** How this sat against the declared task, so a caller can report drift. */
  scope?: ScopeComparison;
}

/** Evaluated where the call is made, so arguments never travel; only ids and signals do. */
export class LocalGate {
  private readonly engine: PolicyEngine;
  private notice: NoticePort | null = null;

  constructor(
    policies: readonly Policy[],
    private readonly options: LocalGateOptions,
  ) {
    this.engine = new PolicyEngine([...policies], {
      defaultEffect: options.defaultEffect ?? DECISION_EFFECT.ALLOW,
    });
  }

  /** Loads the same policy files the runtime reads, from this machine's disk. */
  static async fromFiles(
    filePaths: readonly string[],
    options: LocalGateOptions,
    sources?: OptionalPolicySources,
  ): Promise<LocalGate> {
    return new LocalGate(await loadPolicyFiles(filePaths, sources), options);
  }

  /** The rule set in force locally, for `memnox policy` style reporting. */
  rules(): Policy[] {
    return this.engine.rules();
  }

  /** Noticing the unusual, attached by a seam, since only a seam has a session to notice in. */
  attachNotice(notice: NoticePort): void {
    this.notice = notice;
  }

  /** The rules first, then a second look at what they allowed. */
  evaluate(request: ActionRequest): LocalVerdict {
    const verdict = this.ruled(request);
    return this.notice === null ? verdict : this.notice.consider(request, verdict);
  }

  /** Something the agent read addressed it like a prompt. True when a session was marked. */
  taint(source: string): boolean {
    return this.notice?.taint?.(source) !== undefined;
  }

  /** A person said yes to what was asked, so noticing learns it rather than asking again. */
  personAllowed(request?: ActionRequest): void {
    this.notice?.personAllowed(request);
  }

  private ruled(request: ActionRequest): LocalVerdict {
    const at = this.options.now ?? new Date();
    const drift = scopeOf(this.options.task ?? null, request, (patterns, value) =>
      matchesAny([...patterns], value),
    );
    const evaluation = this.evaluated(request, at, drift);
    // First: nothing a rule or an allowance says lets an agent change what governs it.
    const contained =
      selfProtection(request) ??
      offIntent(this.options.task ?? null, request, evaluation.effect) ??
      this.contained(request, evaluation.effect);
    const effect = effectUnder(evaluation.effect, contained);
    const allowed = this.allowedWithin(request, effect, at);
    return {
      effect: allowed === null ? effect : DECISION_EFFECT.ALLOW,
      reason: reasonOf(allowed, contained, evaluation.reason),
      signals: [
        ...evaluation.matchedPolicies.map(
          (policy) => `${SIGNAL_POLICY_PREFIX}${policy.name}`,
        ),
        ...(contained === null ? [] : [contained.signal]),
        ...(allowed === null ? [] : [`allowance:${allowed.id}`]),
      ],
      matchedPolicies: evaluation.matchedPolicies,
      ...(evaluation.shadowEffect === undefined
        ? {}
        : { shadowEffect: evaluation.shadowEffect }),
      ...(evaluation.alternative === undefined
        ? {}
        : { alternative: evaluation.alternative }),
      ...(drift.match === SCOPE_MATCH.UNDECLARED ? {} : { scope: drift }),
    };
  }

  /**
   * As this agent, and as every agent that started it, the strictest answer winning, so a
   * child never does what its parent may not.
   */
  private evaluated(
    request: ActionRequest,
    at: Date,
    drift: ScopeComparison,
  ): ReturnType<PolicyEngine['evaluate']> {
    const own = this.evaluatedAs(this.options.agentName, request, at, drift);
    let strictest = own;
    for (const parent of this.options.parents ?? []) {
      const theirs = this.evaluatedAs(parent, request, at, drift);
      if (EFFECT_PRECEDENCE[theirs.effect] <= EFFECT_PRECEDENCE[strictest.effect])
        continue;
      strictest = {
        ...theirs,
        reason: `${parent}, which started this agent, may not do this: ${theirs.reason}`,
      };
    }
    return strictest;
  }

  private evaluatedAs(
    agentName: string,
    request: ActionRequest,
    at: Date,
    drift: ScopeComparison,
  ): ReturnType<PolicyEngine['evaluate']> {
    return this.engine.evaluate(request, {
      agentName,
      now: at,
      ...(this.options.agentRole === undefined
        ? {}
        : { agentRole: this.options.agentRole }),
      ...(drift.match === SCOPE_MATCH.UNDECLARED ? {} : { scope: drift.match }),
      ...(this.options.stateFacts === undefined
        ? {}
        : { state: this.options.stateFacts }),
    });
  }

  /** Last, and only over an ask: a scope a person allowed for a while. */
  private allowedWithin(
    request: ActionRequest,
    effect: DecisionEffect,
    at: Date,
  ): Allowance | null {
    if (effect !== DECISION_EFFECT.ASK) return null;
    return allowanceFor(allowancesOf(this.options.allowances), request, {
      agentName: this.options.agentName,
      now: at.toISOString(),
    });
  }

  /** Only an allow is ever tightened; a rule that asks or denies already said more. */
  private contained(
    request: ActionRequest,
    effect: DecisionEffect,
  ): ContainmentAsk | null {
    const containment = this.options.containment;
    if (containment === undefined || effect !== DECISION_EFFECT.ALLOW) return null;
    return containmentAsk(request, containment, request.toolClass);
  }
}

/** What containment makes of the rules' allow: a refusal where it refuses, else a question. */
function effectUnder(
  effect: DecisionEffect,
  contained: ContainmentAsk | null,
): DecisionEffect {
  if (contained === null) return effect;
  return contained.refuses === true ? DECISION_EFFECT.DENY : DECISION_EFFECT.ASK;
}

const CHANGES: readonly string[] = [
  TOOL_CLASS.WRITE,
  TOOL_CLASS.DESTRUCTIVE,
  TOOL_CLASS.COMMUNICATION,
];

/**
 * A task declared as an investigation is held to reading: a change outside this machine
 * is refused with the ask quoted, whatever the rules would have said, a refusal aside.
 */
function offIntent(
  task: SessionTask | null,
  request: ActionRequest,
  effect: DecisionEffect,
): ContainmentAsk | null {
  if (task === null || task.intent !== TASK_INTENT.INVESTIGATE) return null;
  if (effect === DECISION_EFFECT.DENY || !reachesOutside(request.action)) return null;
  if (!CHANGES.includes(request.toolClass ?? '')) return null;
  return {
    reason: `"${task.statement}" is an investigation, and this changes something outside this machine.`,
    signal: 'intent:investigate',
    refuses: true,
  };
}

/** A long-lived gate reads them at each decision, since one granted later must count. */
function allowancesOf(given: LocalGateOptions['allowances']): readonly Allowance[] {
  if (given === undefined) return [];
  return typeof given === 'function' ? given() : given;
}

function reasonOf(
  allowed: Allowance | null,
  contained: ContainmentAsk | null,
  ruled: string,
): string {
  if (allowed !== null) return describeAllowance(allowed);
  return contained === null ? ruled : contained.reason;
}
