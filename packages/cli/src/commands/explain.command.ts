import type { Command } from 'commander';
import {
  READINESS_NEEDS,
  readinessFor,
  type DiscoveryReport,
  type Readiness,
} from '@memnox/discovery';
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

/** Environments a person names in a sentence, longest first so "production" wins. */
const ENVIRONMENTS: readonly string[] = ['production', 'staging', 'prod', 'dev'];

/** What the question resolved to, so a wrong parse is visible rather than mysterious. */
interface ParsedQuestion {
  agent: string;
  action: string;
  environment?: string;
}

/**
 * The question, in the words somebody would have used anyway — turned into an agent,
 * an action and an environment by matching what is on this machine and nothing else.
 *
 * Deterministic on purpose. A model reading the sentence would be a model on the path
 * of an answer about authority, and a plausible reading of a question is worse than
 * an admission that it could not be read.
 */
function parseQuestion(question: string, report: DiscoveryReport): ParsedQuestion | null {
  const words = question.toLowerCase();
  const agent = report.agents.find((each) =>
    kindSpellings(each.kind).some((spelling) => words.includes(spelling)),
  );
  if (agent === undefined) return null;
  // What an agent is called is not what it was asked to do: "claude-code" carries
  // the "code" namespace, so "can claude-code send money" was answered as a
  // question about code rather than refused.
  const asked = kindSpellings(agent.kind).reduce(
    (text, spelling) => text.split(spelling).join(' '),
    words,
  );
  const action = Object.keys(READINESS_NEEDS).find((namespace) =>
    asked.includes(namespace),
  );
  if (action === undefined) return null;

  const environment = ENVIRONMENTS.find((each) => words.includes(each));
  return {
    agent: agent.id,
    action,
    ...(environment === undefined ? {} : { environment }),
  };
}

/** "claude-code" is written "claude code" and "claude" by the people who use it. */
function kindSpellings(kind: string): string[] {
  return [kind, kind.replace(/-/g, ' '), kind.split('-')[0] ?? kind];
}

/**
 * One question, answered in one place. The answer separates what is technically
 * possible from what is organizationally permitted and says plainly which is which,
 * because those are two different facts and conflating them is how a team ends up
 * believing an agent cannot do something it can.
 */
export function registerExplainCommand(
  program: Command,
  context: CliContext,
  buildSeams: (cwd: string) => ScanSeams = defaultScanSeams,
  cwd: () => string = () => process.cwd(),
): void {
  program
    .command('explain <question>')
    .description('Can this agent do this, right now — technically, and organizationally')
    .option('--json', 'emit the answer as JSON')
    .option(
      '--no-probe',
      'do not start MCP servers to ask what they hold; tools go uncounted',
    )
    .action(async (question: string, options: { json?: boolean; probe: boolean }) => {
      const seams = buildSeams(cwd());
      const { report } = await scanMachine(seams, { probe: options.probe });
      const parsed = parseQuestion(question, report);

      if (parsed === null) {
        throw new Error(
          `could not read "${question}" as a question about this machine.\n` +
            `Name an agent that is here and one of: ${Object.keys(READINESS_NEEDS).join(', ')}.\n` +
            'Or ask it directly: memnox readiness <agent> <action>',
        );
      }

      const readiness = readinessFor(report, parsed.agent, parsed.action);
      if (readiness === null) {
        throw new Error(`no agent "${parsed.agent}" on this machine`);
      }

      const rules = await loadLocalRules(seams);
      const gate = new LocalGate(rules.policies, { agentName: readiness.agentKind });
      const verdict = gate.evaluate({
        action: parsed.action,
        ...(parsed.environment === undefined ? {} : { environment: parsed.environment }),
      });

      if (options.json === true) {
        context.out.line(
          JSON.stringify(
            {
              question,
              read: parsed,
              technically: readiness.missing.length === 0,
              effect: verdict.effect,
              reason: verdict.reason,
              ...readiness,
            },
            null,
            2,
          ),
        );
        return;
      }
      render(context, question, parsed, readiness, verdict, rules.unreadable);
    });
}

function render(
  context: CliContext,
  question: string,
  parsed: ParsedQuestion,
  readiness: Readiness,
  verdict: { effect: DecisionEffect; reason: string },
  rulesUnreadable: string | undefined,
): void {
  const { out, style } = context;
  out.line('');
  out.line(style.bold(question));
  out.line(
    style.dim(
      `  read as: ${readiness.agentKind} · ${parsed.action}` +
        (parsed.environment === undefined ? '' : ` · ${parsed.environment}`),
    ),
  );

  const technically = readiness.missing.length === 0;
  out.line('');
  out.line(`${style.bold('TECHNICALLY')}         ${technically ? 'yes' : 'no'}`);
  for (const finding of readiness.has) {
    out.line(`  ${'✓'.padEnd(LABEL_WIDTH)}${finding.need}`);
  }
  for (const finding of readiness.missing) {
    out.line(`  ${style.warn('✕')}${''.padEnd(LABEL_WIDTH - 1)}${finding.need}`);
  }

  /* A broken rule set is not an empty one. Answering "organizationally yes" off rules
     that never parsed would be the lie this whole surface exists not to tell. */
  const answerable = rulesUnreadable === undefined;
  const permitted = answerable && verdict.effect === DECISION_EFFECT.ALLOW;
  out.line('');
  out.line(
    `${style.bold('ORGANIZATIONALLY')}    ${answerable ? (permitted ? 'yes' : 'not right now') : 'not answerable here'}`,
  );
  if (answerable) {
    out.line(
      permitted
        ? `  ${'✓'.padEnd(LABEL_WIDTH)}${verdict.reason}`
        : `  ${style.warn('✕')}${''.padEnd(LABEL_WIDTH - 1)}${verdict.reason}`,
    );
  } else {
    out.line(
      `  ${style.warn('✕')}${''.padEnd(LABEL_WIDTH - 1)}the rules on this machine would not load`,
    );
    out.line(
      `  ${''.padEnd(LABEL_WIDTH)}${style.dim((rulesUnreadable ?? '').split('\n')[0] ?? '')}`,
    );
  }

  out.line('');
  if (!answerable) {
    out.line(style.warn(style.bold('  → NOT ANSWERED')));
  } else {
    out.line(
      technically && permitted
        ? style.bold(`  → ${DECISION_EFFECT.ALLOW.toUpperCase()}`)
        : style.warn(style.bold(`  → ${verdict.effect.toUpperCase()}`)),
    );
  }
  out.line('');
}
