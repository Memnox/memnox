import type { Command } from 'commander';
import {
  findPolicyGaps,
  readRepositoryEvidence,
  statedRuleConflicts,
  type PolicyGap,
  type RepositoryEvidence,
  type StatedRuleConflict,
} from '@memnox/discovery';
import type { CliContext } from '../cli-context';
import { DEFAULT_BASE_URL } from '../defaults';
import { defaultScanSeams, type ScanSeams } from '../machine-scan';

const EXCERPT_WIDTH = 68;
/** Enough recent history to match a week of actions without reading the whole log. */
const LEDGER_WINDOW = 2_000;

/**
 * What this repository already says about itself, and what it already enforces. Read
 * off the disk with the reader's own checkout: no forge, no login, no network.
 *
 * A stated rule is evidence a policy can match on. It permits nothing on its own —
 * the moment text an agent can reach is able to permit an action, every document in
 * the repository becomes a way to write policy.
 */
export function registerEvidenceCommand(
  program: Command,
  context: CliContext,
  buildSeams: (cwd: string) => ScanSeams = defaultScanSeams,
  cwd: () => string = () => process.cwd(),
): void {
  program
    .command('evidence [directory]')
    .description('What this repository states, what it enforces, and the gap between')
    .option('--gaps', 'only the requirements nothing on this disk enforces')
    .option('--against-ledger', 'actions that ran against a rule this repository states')
    .option('--json', 'emit the evidence as JSON')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(
      async (
        directory: string | undefined,
        options: {
          gaps?: boolean;
          againstLedger?: boolean;
          json?: boolean;
          url?: string;
          adminToken?: string;
        },
      ) => {
        const root = directory ?? cwd();
        const seams = buildSeams(root);
        const evidence = await readRepositoryEvidence(seams.reader, root);
        const gaps = findPolicyGaps(evidence).filter(
          (gap) => gap.enforcedBy.length === 0,
        );

        if (options.againstLedger === true) {
          const { client } = await context.connect(options);
          const events = await client.queryAudit({ limit: LEDGER_WINDOW });
          const conflicts = statedRuleConflicts(
            evidence,
            events.map((event) => ({
              agentId: event.agentName,
              action: event.action,
              ...(event.target === undefined ? {} : { target: event.target }),
              at: event.occurredAt,
            })),
          );
          if (options.json === true) {
            context.out.line(JSON.stringify(conflicts, null, 2));
            return;
          }
          renderConflicts(context, conflicts);
          return;
        }

        if (options.json === true) {
          context.out.line(JSON.stringify({ ...evidence, gaps }, null, 2));
          return;
        }
        if (options.gaps === true) {
          renderGaps(context, gaps);
          return;
        }
        render(context, evidence, gaps);
      },
    );
}

function render(
  context: CliContext,
  evidence: RepositoryEvidence,
  gaps: readonly PolicyGap[],
): void {
  const { out, style } = context;
  out.line('');
  out.line(style.bold('WHAT THIS REPOSITORY STATES'));
  out.line('');

  if (evidence.stated.length === 0) {
    // An empty answer is honest: nothing here wrote a rule down, and inventing one
    // out of prose would put the whole checkout into the evidence set.
    out.line('  Nothing here states a rule in the words of a rule.');
    out.line(
      style.dim('  Looked in AGENTS.md, CLAUDE.md, SECURITY.md and the decision log.'),
    );
  }
  for (const rule of evidence.stated) {
    out.line(`  ${excerpt(rule.text)}`);
    out.line(`    ${style.dim(`${rule.statedIn}:${rule.line}  «${rule.source}»`)}`);
  }

  out.line('');
  out.line(style.bold('WHAT THIS REPOSITORY ENFORCES'));
  out.line('');
  if (evidence.enforced.length === 0) {
    out.line('  Nothing on this disk enforces any of it.');
  }
  for (const control of evidence.enforced) {
    out.line(`  ${control.detail}`);
    out.line(`    ${style.dim(`${control.statedIn}  «${control.kind}»`)}`);
  }

  renderGaps(context, gaps);
}

function renderGaps(context: CliContext, gaps: readonly PolicyGap[]): void {
  const { out, style } = context;
  out.line('');
  if (gaps.length === 0) {
    out.line(style.dim('No documented review requirement is unanswered here.'));
    out.line('');
    return;
  }

  out.line(style.warn(style.bold('POLICY GAP')));
  out.line('');
  for (const gap of gaps) {
    out.line(`  documented   ${excerpt(gap.documented.text)}`);
    out.line(
      `               ${style.dim(`${gap.documented.statedIn}:${gap.documented.line}`)}`,
    );
    out.line(`  enforced     ${style.warn('nothing on this disk')}`);
    out.line('');
  }
  // Reporting a gap the open half could not see into would be a lie the reader acts on.
  out.line(style.dim(`  ${gaps[0]?.unread ?? ''}`));
  out.line('');
}

function excerpt(text: string): string {
  return text.length <= EXCERPT_WIDTH ? text : `${text.slice(0, EXCERPT_WIDTH - 1)}…`;
}

/**
 * A sentence somebody wrote, and an action that ran against it. Reported and never
 * enforced: an instruction in a document is evidence, and if reachable text could
 * refuse an action then every file in the checkout becomes a way to write policy.
 */
function renderConflicts(
  context: CliContext,
  conflicts: readonly StatedRuleConflict[],
): void {
  const { out, style } = context;
  out.line('');
  out.line(style.bold('ACTIONS AGAINST A STATED RULE'));
  out.line('');

  if (conflicts.length === 0) {
    // Honest when empty, and it says which half was empty rather than implying both.
    out.line('  Nothing in the recorded history matches a rule stated here.');
    out.line('');
    return;
  }

  for (const conflict of conflicts) {
    out.line(
      `  ${style.warn('!')}  ${conflict.action}${conflict.target === undefined ? '' : ` ${conflict.target}`}`,
    );
    out.line(`     ${style.dim(`${conflict.agentId} · ${conflict.at}`)}`);
    out.line(`     states: ${excerpt(conflict.rule.text)}`);
    out.line(
      `     ${style.dim(`${conflict.rule.statedIn}:${conflict.rule.line}  «shared: ${conflict.matchedOn.join(', ')}»`)}`,
    );
    out.line('');
  }

  out.line(
    style.dim(
      '  Candidates, matched on shared wording rather than on meaning. None of these ' +
        'refused anything: a document is evidence, and only a rule you write enforces.',
    ),
  );
  out.line('');
}
