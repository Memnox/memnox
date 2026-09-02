import type { Command } from 'commander';
import { readinessFor, type Readiness } from '@memnox/discovery';
import { LocalGate } from '@memnox/local-gate';
import { DECISION_EFFECT, type DecisionEffect } from '@memnox/core';
import type { CliContext } from '../cli-context';
import {
  defaultScanSeams,
  loadLocalRules,
  scanMachine,
  type ScanSeams,
} from '../machine-scan';

const LABEL_WIDTH = 4;

/**
 * Asked of the machine rather than of the model. An agent asked whether it can deploy
 * answers about its instructions; this answers about its credentials, its tooling, its
 * reach, and the rule that still refuses — with no account and no network.
 */
export function registerReadinessCommand(
  program: Command,
  context: CliContext,
  buildSeams: (cwd: string) => ScanSeams = defaultScanSeams,
  cwd: () => string = () => process.cwd(),
): void {
  program
    .command('readiness <agent> <action> [target]')
    .description('Whether this agent could actually do this, off the machine itself')
    .option('--env <environment>', 'environment, e.g. production')
    .option('--json', 'emit the answer as JSON')
    .option(
      '--no-probe',
      'do not start MCP servers to ask what they hold; tools go uncounted',
    )
    .action(
      async (
        agent: string,
        action: string,
        target: string | undefined,
        options: { env?: string; json?: boolean; probe: boolean },
      ) => {
        const seams = buildSeams(cwd());
        const { report } = await scanMachine(seams, { probe: options.probe });
        const readiness = readinessFor(report, agent, action);

        if (readiness === null) {
          throw new Error(
            `no agent "${agent}" on this machine — run "memnox" to see what is here`,
          );
        }

        // A registered rule file belongs to another repository and can go stale. The
        // machine half of the answer is still true, so it is printed either way.
        const rules = await loadLocalRules(seams);
        const gate = new LocalGate(rules.policies, { agentName: readiness.agentKind });
        const verdict = gate.evaluate({
          action,
          ...(target === undefined ? {} : { target }),
          ...(options.env === undefined ? {} : { environment: options.env }),
        });

        const authorized =
          readiness.missing.length === 0 &&
          rules.unreadable === undefined &&
          verdict.effect === DECISION_EFFECT.ALLOW;

        if (options.json === true) {
          context.out.line(
            JSON.stringify(
              {
                ...readiness,
                effect: verdict.effect,
                reason: verdict.reason,
                authorized,
              },
              null,
              2,
            ),
          );
          return;
        }
        render(context, readiness, verdict, authorized, rules.unreadable);
      },
    );
}

function render(
  context: CliContext,
  readiness: Readiness,
  verdict: { effect: DecisionEffect; reason: string },
  authorized: boolean,
  rulesUnreadable: string | undefined,
): void {
  const { out, style } = context;
  out.line('');
  out.line(
    style.bold(`Can ${readiness.agentKind} ${readiness.action.replace(/\./g, ' ')}?`),
  );

  if (!readiness.known) {
    // A namespace with no stated needs is not a satisfied one, and saying so is
    // cheaper than an answer built out of nothing.
    out.line('');
    out.line(`  Nothing is known about what "${readiness.action}" needs on a machine.`);
  }

  if (readiness.has.length > 0) {
    out.line('');
    out.line(style.bold('HAS'));
    out.line('');
    for (const finding of readiness.has) {
      out.line(`  ${'✓'.padEnd(LABEL_WIDTH)}${finding.need}`);
      if (finding.evidence !== undefined) {
        out.line(`  ${''.padEnd(LABEL_WIDTH)}${style.dim(finding.evidence)}`);
      }
    }
  }

  const refuses = verdict.effect !== DECISION_EFFECT.ALLOW;
  if (readiness.missing.length > 0 || refuses || rulesUnreadable !== undefined) {
    out.line('');
    out.line(style.bold('BUT'));
    out.line('');
    for (const finding of readiness.missing) {
      out.line(`  ${style.warn('✕')}${''.padEnd(LABEL_WIDTH - 1)}${finding.need}`);
    }
    if (refuses) {
      out.line(
        `  ${style.warn('✕')}${''.padEnd(LABEL_WIDTH - 1)}${verdict.effect}: ${verdict.reason}`,
      );
    }
    if (rulesUnreadable !== undefined) {
      out.line(
        `  ${style.warn('✕')}${''.padEnd(LABEL_WIDTH - 1)}the rules on this machine would not load`,
      );
      out.line(
        `  ${''.padEnd(LABEL_WIDTH)}${style.dim(rulesUnreadable.split('\n')[0] ?? '')}`,
      );
    }
  }

  out.line('');
  out.line(
    authorized
      ? style.bold('  → AUTHORIZED')
      : style.warn(style.bold('  → NOT AUTHORIZED')),
  );
  out.line('');
}
