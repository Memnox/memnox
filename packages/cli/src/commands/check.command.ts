import { homedir } from 'node:os';
import type { Command } from 'commander';
import {
  DECISION_EFFECT,
  INTENT_KIND,
  LocalGate,
  type PolicySet,
  preflightFor,
  overlaysInForce,
  stateFactsInForce,
  type Preflight,
  type LocalVerdict,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { policySetInForce, sayWhatDidNotLoad } from '../policy-path';

interface Ruling {
  action: string;
  verdict: LocalVerdict;
}

/**
 * The expensive decision, made while it is cheap. Every gate in this category is an
 * interrupt, and an interrupt is answered by whoever is in the terminal at the moment
 * they can least afford to think about it — so the answer is almost always yes.
 */
export function registerCheckCommand(
  program: Command,
  context: CliContext,
  now: () => string = () => new Date().toISOString(),
): void {
  program
    .command('check <intent>')
    .description(
      'Decide before the loop starts: what this would do, and what would stop it',
    )
    .option('-a, --agent <name>', 'agent the rules are matched against', 'agent')
    .action(async (intent: string, options: { agent: string }) => {
      const preflight = preflightFor(intent, process.env);
      const { out } = context;

      if (preflight.unrecognized !== undefined) {
        out.line(preflight.unrecognized);
        process.exitCode = 1;
        return;
      }
      if (preflight.actions.length === 0) {
        out.line('Nothing on this machine does that, so there is nothing to decide.');
        return;
      }

      const { gate, rules } = await buildGate(options.agent, now());
      // A file that would not load is not an absent rule, so it is never silent here.
      sayWhatDidNotLoad(context, rules);
      const rulings = preflight.actions.map((action) => ({
        action: action.action,
        verdict: gate.evaluate({
          action: action.action,
          ...(action.target === undefined ? {} : { target: action.target }),
        }),
      }));

      render(context, preflight, rulings);
      // Non-zero when something would stop, so this is usable in a pre-agent script.
      if (rulings.some((ruling) => ruling.verdict.effect !== DECISION_EFFECT.ALLOW)) {
        process.exitCode = 1;
      }
    });
}

/** The rules actually in force here, plus whatever state is open — the same as the gate. */
async function buildGate(
  agent: string,
  moment: string,
): Promise<{ gate: LocalGate; rules: PolicySet }> {
  const home = homedir();
  const rules = await policySetInForce(home);
  const overlays = await overlaysInForce(home);
  return {
    rules,
    gate: new LocalGate(rules.policies, {
      agentName: agent,
      stateFacts: stateFactsInForce(overlays, moment),
    }),
  };
}

const ORDER: Record<string, number> = {
  [DECISION_EFFECT.DENY]: 0,
  [DECISION_EFFECT.ASK]: 1,
  [DECISION_EFFECT.ALLOW]: 2,
};

function render(
  context: CliContext,
  preflight: Preflight,
  rulings: readonly Ruling[],
): void {
  const { out, style } = context;
  const stopped = rulings.filter(
    (ruling) => ruling.verdict.effect !== DECISION_EFFECT.ALLOW,
  );

  /* A phrase means more than one command until somebody says which, so what it was read
     as is printed — a wrong reading has to be visible rather than mysterious. */
  if (preflight.kind === INTENT_KIND.PHRASE) {
    const subject = preflight.subject === undefined ? '' : ` · ${preflight.subject}`;
    out.line(style.dim(`read as: ${preflight.verb ?? '?'}${subject}`));
    out.line('');
  }

  const width = Math.max(...rulings.map((ruling) => ruling.action.length)) + 2;
  const shown = [...rulings].sort(
    (a, b) => (ORDER[a.verdict.effect] ?? 3) - (ORDER[b.verdict.effect] ?? 3),
  );
  /* One reason for the whole list is a footnote, not eleven columns of it. Printed
     per row it pushed the actions off the left of anybody's attention. */
  const reasons = new Set(rulings.map((ruling) => ruling.verdict.reason));
  const shared = reasons.size === 1 ? [...reasons][0] : undefined;
  for (const ruling of shown) {
    const effect = ruling.verdict.effect;
    const label =
      effect === DECISION_EFFECT.DENY
        ? style.warn('deny ')
        : effect === DECISION_EFFECT.ASK
          ? style.warn('ask  ')
          : style.dim('allow');
    const reason = shared === undefined ? style.dim(ruling.verdict.reason) : '';
    out.line(`  ${label}  ${ruling.action.padEnd(width)}${reason}`.trimEnd());
  }
  if (shared !== undefined) {
    out.line('');
    out.line(`  ${style.dim(shared)}`);
  }

  out.line('');
  if (stopped.length === 0) {
    /* An unruled action is not a permitted one. Reporting eleven of them as "nothing
       would stop" is the comfortable lie: no rule covers them, which is a different
       fact from a rule having allowed them, and it is the one worth acting on. */
    const unruled = rulings.filter(
      (ruling) => ruling.verdict.matchedPolicies.length === 0,
    ).length;
    if (unruled === rulings.length) {
      out.line(
        `Nothing here would stop, and no rule covers any of it. ${rulings.length} action(s) checked.`,
      );
      out.line(
        `  ${style.dim('memnox protect')}   put the dangerous ones behind ask or deny`,
      );
      return;
    }
    out.line(
      unruled === 0
        ? `Nothing here would stop. ${rulings.length} action(s) checked.`
        : `Nothing here would stop. ${rulings.length} action(s) checked, ${unruled} of them covered by no rule.`,
    );
    return;
  }
  out.line(
    `${stopped.length} of ${rulings.length} would stop, and nothing was run to find out.`,
  );
  const frozen = stopped.find((ruling) =>
    /freez|frozen|incident/i.test(ruling.verdict.reason),
  );
  if (frozen !== undefined) {
    out.line(`  ${style.dim('memnox freeze --lift')}   when the incident is over`);
  }
}
