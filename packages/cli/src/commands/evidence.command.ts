import type { Command } from 'commander';
import {
  findPolicyGaps,
  readRepositoryEvidence,
  type PolicyGap,
  type RepositoryEvidence,
} from '@memnox/discovery';
import type { CliContext } from '../cli-context';
import { defaultScanSeams, type ScanSeams } from '../machine-scan';

const EXCERPT_WIDTH = 68;

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
    .option('--json', 'emit the evidence as JSON')
    .action(
      async (
        directory: string | undefined,
        options: { gaps?: boolean; json?: boolean },
      ) => {
        const root = directory ?? cwd();
        const seams = buildSeams(root);
        const evidence = await readRepositoryEvidence(seams.reader, root);
        const gaps = findPolicyGaps(evidence).filter(
          (gap) => gap.enforcedBy.length === 0,
        );

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
