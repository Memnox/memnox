import { DECISION_EFFECT } from '../constants/decision.constants';
import type { MemnoxEvent } from '../event/event';
import { didFail, workKey } from '../event/outcome';
import { DEFAULT_THRESHOLDS } from './breaker';
import { roundToCents } from './money';

/**
 * A day of agent operations added up from the ledger: what the work cost and what of it
 * was wasted. No spend line unless something priced the events.
 */

/** The worst few, because a table nobody scrolls is one nobody reads to the end of. */
const WORST_SHOWN = 5;

/** Quoted from the breaker rather than repeated, so the advice matches what would fire. */
const BREAKER_ERROR_LOOP = DEFAULT_THRESHOLDS.errorLoop;

export interface WasteSource {
  action: string;
  /** Times it ran and failed. The count is the finding. */
  failures: number;
  /** Times it ran at all, so a flaky thing reads differently from a broken one. */
  attempts: number;
}

export interface OperationsReport {
  since: string;
  until: string;
  agents: number;
  sessions: number;
  actions: number;
  succeeded: number;
  failed: number;
  blocked: number;
  held: number;
  /** Actions that ran more than once with the same target: work redone. */
  retries: number;
  /** Where the redone work went, worst first. */
  waste: WasteSource[];
  busiest: { agent: string; actions: number } | null;
  /** Dollars somebody reported. Null means nobody did, which must not read as $0.00. */
  spentUsd: number | null;
  /** Of that, what went on work that was redone. The number people act on. */
  wastedUsd: number | null;
}

function ran(event: MemnoxEvent): boolean {
  return event.effect === DECISION_EFFECT.ALLOW;
}

/** What one pass over the window counts, before it is shaped into a report. */
interface Tallies {
  agents: Set<string>;
  sessions: Set<string>;
  perAgent: Map<string, number>;
  /** Ids of the runs after the first of the same work, which is the part that is waste. */
  redone: Set<string>;
  byOperation: Map<string, WasteSource>;
  succeeded: number;
  failed: number;
  blocked: number;
  held: number;
}

export function operationsReport(
  events: readonly MemnoxEvent[],
  since: string,
  until: string,
): OperationsReport {
  const window = events.filter((event) => event.at >= since && event.at <= until);
  const tallies = tallyWindow(window);
  const busiest = [...tallies.perAgent].sort((a, b) => b[1] - a[1])[0];
  const spend = spendOf(window, tallies.redone);
  return {
    since,
    until,
    agents: tallies.agents.size,
    sessions: tallies.sessions.size,
    actions: window.length,
    succeeded: tallies.succeeded,
    failed: tallies.failed,
    blocked: tallies.blocked,
    held: tallies.held,
    retries: tallies.redone.size,
    waste: worstWaste(tallies.byOperation),
    busiest: busiest === undefined ? null : { agent: busiest[0], actions: busiest[1] },
    ...spend,
  };
}

function tallyWindow(window: readonly MemnoxEvent[]): Tallies {
  const tallies: Tallies = {
    agents: new Set(),
    sessions: new Set(),
    perAgent: new Map(),
    redone: new Set(),
    byOperation: new Map(),
    succeeded: 0,
    failed: 0,
    blocked: 0,
    held: 0,
  };
  const runsOf = new Map<string, number>();
  for (const event of window) {
    tallies.agents.add(event.agent);
    tallies.sessions.add(event.sessionId);
    tallies.perAgent.set(event.agent, (tallies.perAgent.get(event.agent) ?? 0) + 1);
    if (event.effect === DECISION_EFFECT.DENY) tallies.blocked += 1;
    if (event.effect === DECISION_EFFECT.ASK) tallies.held += 1;
    if (!ran(event)) continue;

    const before = runsOf.get(workKey(event)) ?? 0;
    if (before > 0) tallies.redone.add(event.id);
    runsOf.set(workKey(event), before + 1);
    tallyRun(tallies, event);
  }
  return tallies;
}

function tallyRun(tallies: Tallies, event: MemnoxEvent): void {
  const source = tallies.byOperation.get(event.operation) ?? {
    action: event.operation,
    failures: 0,
    attempts: 0,
  };
  source.attempts += 1;
  if (didFail(event)) {
    tallies.failed += 1;
    source.failures += 1;
  } else {
    tallies.succeeded += 1;
  }
  tallies.byOperation.set(event.operation, source);
}

function worstWaste(byOperation: ReadonlyMap<string, WasteSource>): WasteSource[] {
  return [...byOperation.values()]
    .filter((source) => source.failures > 1)
    .sort((a, b) => b.failures - a.failures)
    .slice(0, WORST_SHOWN);
}

/** Reported costs only, so a window nobody priced has no spend line rather than $0.00. */
function spendOf(
  window: readonly MemnoxEvent[],
  redone: ReadonlySet<string>,
): Pick<OperationsReport, 'spentUsd' | 'wastedUsd'> {
  const priced = window.filter((event) => event.costUsd !== undefined);
  if (priced.length === 0) return { spentUsd: null, wastedUsd: null };
  return {
    spentUsd: sumCost(priced),
    wastedUsd: sumCost(priced.filter((event) => redone.has(event.id))),
  };
}

function sumCost(events: readonly MemnoxEvent[]): number {
  return roundToCents(events.reduce((sum, event) => sum + (event.costUsd ?? 0), 0));
}

/** The one recommendation allowed, and only when the ledger shows a loop. */
export function recommendation(report: OperationsReport): string | null {
  const worst = report.waste[0];
  if (worst === undefined) return null;
  if (worst.failures < BREAKER_ERROR_LOOP) return null;
  return `${worst.action} failed ${worst.failures} times of ${worst.attempts}. "memnox claims" checks what was said about it; the breaker would have stopped it at ${BREAKER_ERROR_LOOP}.`;
}
