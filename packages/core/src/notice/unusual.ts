/**
 * Whether an action the rules allowed is unusual enough to ask about, and the verdict that
 * follows. Pure and table driven: no model, and the same facts answer the same way on replay.
 */
import {
  DECISION_EFFECT,
  EFFECT_PRECEDENCE,
  type DecisionEffect,
} from '../constants/decision.constants';
import { CHAIN_LINK } from '../discovery/composition';
import { MCP_CONFIG_LOCATIONS } from '../discovery/wrap';
import { describeEgress, inspectEgress } from '../domain/egress-inspector';
import { riskLabelFor, type ActionShape } from './action-shape';
import {
  MOST_STEPS_NAMED,
  NOTICE_MODE,
  NOTICE_SIGNAL,
  NOTICE_SIGNAL_PREFIX,
  type NoticeMode,
  type NoticeSignal,
} from './notice.constants';
import type { Acquired, Taint } from './notice-state';

/** One reason an allowed action deserves a person, and how strongly. */
export interface Notice {
  signal: NoticeSignal;
  effect: DecisionEffect;
  reason: string;
}

/** Everything a notice is decided from, read from local state before this is called. */
export interface NoticeFacts {
  agent: string;
  action: string;
  shape: ActionShape;
  /** LOCAL ONLY: the payload, read for a credential shape once a chain completes. */
  fields?: Readonly<Record<string, string>>;
  novel: boolean;
  /** Inside the period after setup when novelty records and never asks. */
  warmingUp: boolean;
  /** What this session took inside the chain window, oldest first. */
  acquired: readonly Acquired[];
  taint: Taint | null;
}

/** The parts of a verdict a notice changes; the gate's own verdict has more. */
export interface VerdictLike {
  effect: DecisionEffect;
  reason: string;
  signals: string[];
  shadowEffect?: DecisionEffect;
}

export interface NoticeApplication {
  notices: readonly Notice[];
  mode: NoticeMode;
  action: string;
}

/** Taint first, then the chain, then novelty, which is the order a person should read them. */
export function noticesFor(facts: NoticeFacts): Notice[] {
  const found = [taintNotice(facts), chainNotice(facts), noveltyNotice(facts)];
  return found.filter((each): each is Notice => each !== null);
}

/** Enforce changes the effect; observe keeps it and says what enforce would have done. */
export function applyNotices<T extends VerdictLike>(
  verdict: T,
  application: NoticeApplication,
): T {
  const { notices, mode, action } = application;
  if (notices.length === 0 || mode === NOTICE_MODE.OFF) return verdict;
  const effect = strictest(notices.map((each) => each.effect));
  const label = riskLabelFor(action);
  const said = [notices.map((each) => each.reason).join('; '), label]
    .filter((part): part is string => part !== null)
    .join('. ');
  const signals = [
    ...verdict.signals,
    ...notices.map((each) => `${NOTICE_SIGNAL_PREFIX}${each.signal}`),
  ];
  if (mode === NOTICE_MODE.ENFORCE) return { ...verdict, effect, reason: said, signals };
  return {
    ...verdict,
    reason: `${said} (observe mode, so it was allowed)`,
    signals,
    shadowEffect: strictest([verdict.shadowEffect ?? DECISION_EFFECT.ALLOW, effect]),
  };
}

/** The product name when this runtime knows one, so a reason says "Claude Code". */
export function productNameOf(agent: string): string {
  return MCP_CONFIG_LOCATIONS.find((each) => each.agent === agent)?.product ?? agent;
}

function taintNotice(facts: NoticeFacts): Notice | null {
  const { taint, shape } = facts;
  if (taint === null || !(shape.outward || shape.destructive)) return null;
  return {
    signal: NOTICE_SIGNAL.TAINT,
    effect: DECISION_EFFECT.ASK,
    reason:
      `a tool result from ${taint.source} read like instructions, so until ${taint.until} ` +
      'outward and destructive actions in this session need a person',
  };
}

function chainNotice(facts: NoticeFacts): Notice | null {
  const { shape, acquired } = facts;
  if (shape.link !== CHAIN_LINK.EMIT || acquired.length === 0) return null;
  const steps = [...new Set(acquired.map((each) => each.step))].slice(-MOST_STEPS_NAMED);
  const path = `${steps.join(', then ')}, then ${shape.step}`;
  const reason = `${path}: individually permitted, together an exfiltration path`;
  const inspection = inspectEgress({ fields: facts.fields ?? {} });
  if (inspection.findings.length === 0) {
    return { signal: NOTICE_SIGNAL.CHAIN, effect: DECISION_EFFECT.ASK, reason };
  }
  // A credential in the payload of the send that completes the path is not a question.
  return {
    signal: NOTICE_SIGNAL.CHAIN,
    effect: DECISION_EFFECT.DENY,
    reason: `${reason}, and ${describeEgress(inspection)}`,
  };
}

function noveltyNotice(facts: NoticeFacts): Notice | null {
  const novelty = facts.shape.novelty;
  if (novelty === null || !facts.novel || facts.warmingUp) return null;
  return {
    signal: NOTICE_SIGNAL.NOVEL,
    effect: DECISION_EFFECT.ASK,
    reason: `${productNameOf(facts.agent)} has never done this before: ${novelty.first}`,
  };
}

function strictest(effects: readonly DecisionEffect[]): DecisionEffect {
  return effects.reduce<DecisionEffect>(
    (worst, each) => (EFFECT_PRECEDENCE[each] > EFFECT_PRECEDENCE[worst] ? each : worst),
    DECISION_EFFECT.ALLOW,
  );
}
