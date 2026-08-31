import type { Command } from 'commander';
import { AUTONOMY_LEVEL_NAME, READINESS_STATUS } from '@memnox/autonomy';
import type { ReadinessResponse } from '@memnox/sdk';
import type { CliContext } from '../cli-context';
import { DEFAULT_BASE_URL } from '../defaults';

const KEY_WIDTH = 22;

/**
 * Can this agent safely be given more authority than it has? Every item is a query
 * against something already stored, so the answer cannot be aspirational and nobody
 * can tick one. Trust never widens authority on its own: this is evidence for a person.
 */
export function registerReadinessCommand(program: Command, context: CliContext): void {
  program
    .command('readiness <agentId>')
    .description('What is stopping this agent from holding more authority, item by item')
    .option(
      '--level <n>',
      'assess against one level (0-5) instead of the highest it reaches',
    )
    .option('--json', 'emit the checklist as JSON')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(
      async (
        agentId: string,
        options: { level?: string; json?: boolean; url?: string; adminToken?: string },
      ) => {
        const { out } = context;
        const { client } = await context.connect(options);
        const level = options.level === undefined ? undefined : Number(options.level);
        if (level !== undefined && !Number.isFinite(level)) {
          throw new Error('--level must be a number from 0 to 5');
        }

        const response = await client.readiness(agentId, level);
        if (options.json === true) {
          out.line(JSON.stringify(response, null, 2));
          return;
        }
        render(context, agentId, response);
      },
    );
}

function render(context: CliContext, agentId: string, response: ReadinessResponse): void {
  const { out, style } = context;
  const { readiness, highestReady } = response;

  out.line(style.bold(`READINESS  ${agentId}`));
  out.line('');
  out.line(
    highestReady === null
      ? '  Ready for no level yet.'
      : `  Ready for level ${highestReady} — ${levelName(highestReady)}.`,
  );
  out.line('');
  out.line(
    style.bold(`Against level ${readiness.level} — ${levelName(readiness.level)}`),
  );
  out.line('');

  for (const item of readiness.items) {
    const mark =
      item.status === READINESS_STATUS.MET
        ? style.ok('✓')
        : item.status === READINESS_STATUS.UNKNOWN
          ? style.dim('?')
          : style.warn('✗');
    out.line(`  ${mark} ${item.key.padEnd(KEY_WIDTH)}${style.dim(item.query)}`);
    if (item.blocker !== undefined) {
      out.line(`    ${' '.repeat(KEY_WIDTH)}${item.blocker}`);
    }
    if (item.remediation !== undefined) {
      out.line(`    ${' '.repeat(KEY_WIDTH)}${style.dim(`→ ${item.remediation}`)}`);
    }
  }

  out.note('');
  // Nothing promotes without a person, whatever this checklist says.
  out.note(
    style.dim(
      'A met checklist is evidence for a person, never a grant. Somebody still decides.',
    ),
  );
}

function levelName(level: number): string {
  const known = AUTONOMY_LEVEL_NAME[level as keyof typeof AUTONOMY_LEVEL_NAME];
  return known ?? 'unknown level';
}
