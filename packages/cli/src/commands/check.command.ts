import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import {
  DECISION_EFFECT,
  INTENT_KIND,
  LocalGate,
  loadPolicySet,
  MEMNOX_HOME,
  preflightFor,
  readOverlays,
  readPolicyRegistry,
  stateFactsInForce,
  type Preflight,
  type LocalVerdict,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { resolvePolicyFile } from '../policy-path';

const REGISTRY_FILE = 'policies.json';

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

      const gate = await buildGate(options.agent, now());
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
async function buildGate(agent: string, moment: string): Promise<LocalGate> {
  const home = homedir();
  const registered = await readPolicyRegistry(join(home, MEMNOX_HOME, REGISTRY_FILE));
  const here = resolvePolicyFile();
  const files = new Set(registered);
  if (existsSync(here)) files.add(here);

  const set = await loadPolicySet([...files]);
  const overlays = await readOverlays(home);
  return new LocalGate(set.policies, {
    agentName: agent,
    stateFacts: stateFactsInForce(overlays, moment),
  });
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
  for (const ruling of shown) {
    const effect = ruling.verdict.effect;
    const label =
      effect === DECISION_EFFECT.DENY
        ? style.warn('deny ')
        : effect === DECISION_EFFECT.ASK
          ? style.warn('ask  ')
          : style.dim('allow');
    out.line(
      `  ${label}  ${ruling.action.padEnd(width)}${style.dim(ruling.verdict.reason)}`,
    );
  }

  out.line('');
  if (stopped.length === 0) {
    out.line(`Nothing here would stop. ${rulings.length} action(s) checked.`);
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
