/**
 * `memnox check`: what an intent would do, and what would stop it, before anything runs.
 * Same engine, same rules, same state, asked while the decision is still cheap.
 */

import { homedir } from 'node:os';
import type { Command } from 'commander';
import {
  DECISION_EFFECT,
  EFFECT_PRECEDENCE,
  EXIT,
  INTENT_KIND,
  LocalGate,
  type PolicySet,
  preflightFor,
  overlaysInForce,
  stateLabelsOf,
  type Preflight,
  type LocalVerdict,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { policySetInForce, renderWhatDidNotLoad } from '../policy-path';

interface Ruling {
  action: string;
  verdict: LocalVerdict;
}

/** What `check` reads the machine through, injected so a test never reads the real one. */
interface CheckDeps {
  now: () => string;
  home: () => string;
  env: NodeJS.ProcessEnv;
}

interface CheckOptions {
  agent: string;
}

export function registerCheckCommand(
  program: Command,
  context: CliContext,
  overrides: Partial<CheckDeps> = {},
): void {
  const deps: CheckDeps = {
    now: () => new Date().toISOString(),
    home: homedir,
    env: process.env,
    ...overrides,
  };
  program
    .command('check <intent>')
    .description(
      'Decide before the loop starts: what this would do, and what would stop it',
    )
    .option('-a, --agent <name>', 'agent the rules are matched against', 'agent')
    .action(async (intent: string, options: CheckOptions) =>
      runCheck(context, deps, intent, options),
    );
}

/** Puts an intent through the gate ahead of time, running and changing nothing. */
async function runCheck(
  context: CliContext,
  deps: CheckDeps,
  intent: string,
  options: CheckOptions,
): Promise<void> {
  const preflight = preflightFor(intent, deps.env);
  const { flow } = context;
  flow.open('memnox check');

  if (preflight.unrecognized !== undefined) {
    flow.close(preflight.unrecognized);
    process.exitCode = EXIT.FAILED;
    return;
  }
  if (preflight.actions.length === 0) {
    flow.close('Nothing on this machine does that, so there is nothing to decide.');
    return;
  }

  const { gate, rules } = await buildGate(deps.home(), options.agent, deps.now());
  // A file that would not load is not an absent rule, so it is never silent here.
  renderWhatDidNotLoad(context, rules);
  const rulings = preflight.actions.map((action) => ({
    action: action.action,
    verdict: gate.evaluate({
      action: action.action,
      ...(action.target === undefined ? {} : { target: action.target }),
    }),
  }));

  renderRulings(context, preflight, rulings);
  // Non-zero when something would stop, so this is usable in a pre-agent script.
  if (rulings.some((ruling) => ruling.verdict.effect !== DECISION_EFFECT.ALLOW)) {
    process.exitCode = EXIT.FAILED;
  }
}

/** The rules actually in force here, plus whatever state is open, which is what the gate reads. */
async function buildGate(
  home: string,
  agent: string,
  moment: string,
): Promise<{ gate: LocalGate; rules: PolicySet }> {
  const rules = await policySetInForce(home);
  const overlays = await overlaysInForce(home);
  return {
    rules,
    gate: new LocalGate(rules.policies, {
      agentName: agent,
      stateFacts: stateLabelsOf(overlays, moment),
    }),
  };
}

function renderRulings(
  context: CliContext,
  preflight: Preflight,
  rulings: readonly Ruling[],
): void {
  // A wrong reading of a phrase has to be visible rather than mysterious.
  if (preflight.kind === INTENT_KIND.PHRASE) {
    const subject = preflight.subject === undefined ? '' : ` · ${preflight.subject}`;
    context.flow.step('Read as', `${preflight.verb ?? '?'}${subject}`);
  }
  renderTable(context, rulings);

  const stopped = rulings.filter(
    (ruling) => ruling.verdict.effect !== DECISION_EFFECT.ALLOW,
  );
  if (stopped.length === 0) {
    renderNothingStops(context, rulings);
    return;
  }
  renderStopped(context, stopped, rulings.length);
}

/** Strictest first, and the reason as a column only where the reasons differ. */
function renderTable(context: CliContext, rulings: readonly Ruling[]): void {
  const { flow, style } = context;
  const shown = [...rulings].sort(
    (a, b) => EFFECT_PRECEDENCE[b.verdict.effect] - EFFECT_PRECEDENCE[a.verdict.effect],
  );
  // One reason for the whole list is a footnote, not a column repeating it on every row.
  const reasons = new Set(rulings.map((ruling) => ruling.verdict.reason));
  const shared = reasons.size === 1 ? [...reasons][0] : undefined;
  flow.table(
    'What would happen, and nothing was run to find out',
    shared === undefined ? ['', 'Action', 'Reason'] : ['', 'Action'],
    shown.map((ruling) => [
      style.effect(ruling.verdict.effect, ruling.verdict.effect),
      ruling.action,
      ...(shared === undefined ? [ruling.verdict.reason] : []),
    ]),
  );
  if (shared !== undefined) flow.aside(style.dim(shared));
}

/** An unruled action is not a permitted one, so no rule covering it is said out loud. */
function renderNothingStops(context: CliContext, rulings: readonly Ruling[]): void {
  const { flow } = context;
  const unruled = rulings.filter(
    (ruling) => ruling.verdict.matchedPolicies.length === 0,
  ).length;
  if (unruled === rulings.length) {
    flow.close(
      `Nothing here would stop, and no rule covers any of it. ${rulings.length} action(s) checked.`,
    );
    flow.hint('memnox protect   puts the dangerous ones behind ask or deny');
    return;
  }
  flow.close(
    unruled === 0
      ? `Nothing here would stop. ${rulings.length} action(s) checked.`
      : `Nothing here would stop. ${rulings.length} action(s) checked, ${unruled} of them covered by no rule.`,
  );
}

function renderStopped(
  context: CliContext,
  stopped: readonly Ruling[],
  checked: number,
): void {
  const { flow, style } = context;
  flow.close(
    style.warn(
      `${stopped.length} of ${checked} would stop, and nothing was run to find out.`,
    ),
  );
  const frozen = stopped.find((ruling) =>
    /freez|frozen|incident/i.test(ruling.verdict.reason),
  );
  if (frozen !== undefined) {
    flow.hint('memnox freeze --lift   when the incident is over');
  }
}
