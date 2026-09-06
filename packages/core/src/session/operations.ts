import { DECISION_EFFECT } from '../constants/decision.constants';
import { EXECUTION } from '../event/event';
import type { MemnoxEvent } from '../event/event';

/**
 * A day of agent operations, added up.
 *
 * Not a security screen: this is what the work cost and what of it was wasted. The
 * numbers people act on are the ones about waste — the same command failing forty
 * times is money and nobody notices, because each individual failure looks like an
 * ordinary bad afternoon.
 *
 * Every figure is counted from the ledger. There is no spend line unless something
 * priced the events, because this machine watches a command run and has no idea what
 * the model behind it charged, and an invented dollar figure is one somebody would
 * take to a finance meeting.
 */

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
  /**
   * Dollars, and only what something reported. Null means nobody reported any, which
   * is a different sentence from "$0.00 was spent" and has to read as one: this
   * machine cannot price a model call and will not pretend a silence is a zero.
   */
  spentUsd: number | null;
  /** Of that, what went on work that was redone. The number people act on. */
  wastedUsd: number | null;
}

function ran(event: MemnoxEvent): boolean {
  return event.effect === DECISION_EFFECT.ALLOW;
}

function failed(event: MemnoxEvent): boolean {
  return (
    event.execution === EXECUTION.FAILED ||
    (event.exitCode !== undefined && event.exitCode !== 0)
  );
}

export function operationsReport(
  events: readonly MemnoxEvent[],
  since: string,
  until: string,
): OperationsReport {
  const window = events.filter((event) => event.at >= since && event.at <= until);
  const agents = new Set<string>();
  const sessions = new Set<string>();
  const perAgent = new Map<string, number>();
  const seen = new Map<string, number>();
  /**
   * Ids of the attempts after the first. The first attempt was the work; everything
   * after it is the work being done again, and that is the part that is waste.
   */
  const redone = new Set<string>();
  const failures = new Map<string, { failures: number; attempts: number }>();

  let succeeded = 0;
  let failedCount = 0;
  let blocked = 0;
  let held = 0;
  let retries = 0;

  for (const event of window) {
    agents.add(event.agent);
    sessions.add(event.sessionId);
    perAgent.set(event.agent, (perAgent.get(event.agent) ?? 0) + 1);

    if (event.effect === DECISION_EFFECT.DENY) blocked += 1;
    if (event.effect === DECISION_EFFECT.ASK) held += 1;
    if (!ran(event)) continue;

    const key = keyOf(event);
    const before = seen.get(key) ?? 0;
    if (before > 0) redone.add(event.id);
    // The second run of the same thing on the same target is work being redone.
    if (before > 0) retries += 1;
    seen.set(key, before + 1);

    const tally = failures.get(event.operation) ?? { failures: 0, attempts: 0 };
    tally.attempts += 1;
    if (failed(event)) {
      failedCount += 1;
      tally.failures += 1;
    } else {
      succeeded += 1;
    }
    failures.set(event.operation, tally);
  }

  const waste = [...failures]
    .filter(([, tally]) => tally.failures > 1)
    .map(([action, tally]) => ({ action, ...tally }))
    .sort((a, b) => b.failures - a.failures)
    .slice(0, 5);

  const busiest = [...perAgent].sort((a, b) => b[1] - a[1])[0];

  /* Reported costs only. Nothing here prices a call, so a window in which nobody
     reported anything has no spend line rather than a reassuring $0.00. */
  const priced = window.filter((event) => event.costUsd !== undefined);
  const spentUsd = priced.length === 0 ? null : sumCost(priced);
  const wasted = priced.filter((event) => redone.has(event.id));

  return {
    since,
    until,
    agents: agents.size,
    sessions: sessions.size,
    actions: window.length,
    succeeded,
    failed: failedCount,
    blocked,
    held,
    retries,
    waste,
    busiest: busiest === undefined ? null : { agent: busiest[0], actions: busiest[1] },
    spentUsd,
    wastedUsd: spentUsd === null ? null : sumCost(wasted),
  };
}

function sumCost(events: readonly MemnoxEvent[]): number {
  const total = events.reduce((sum, event) => sum + (event.costUsd ?? 0), 0);
  // Two decimals, because this is money on a screen and not a float to compute with.
  return Math.round(total * 100) / 100;
}

function keyOf(event: MemnoxEvent): string {
  return `${event.operation}:${event.target ?? ''}`;
}

/**
 * The one recommendation this report is allowed to make.
 *
 * Only when the ledger actually shows a loop. A screen that always ends with "enable
 * the circuit breaker" is an advertisement, and people stop reading the rest of it.
 */
export function recommendation(report: OperationsReport): string | null {
  const worst = report.waste[0];
  if (worst === undefined) return null;
  if (worst.failures < 5) return null;
  return `${worst.action} failed ${worst.failures} times of ${worst.attempts}. "memnox claims" checks what was said about it; the breaker would have stopped it at 5.`;
}
