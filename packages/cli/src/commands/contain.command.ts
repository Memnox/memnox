import type { Command } from 'commander';
import {
  CONTAINMENT_KIND,
  type ContainmentAction,
  type ContainmentKind,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { DEFAULT_BASE_URL } from '../defaults';

const EXIT_PARTIAL = 4;

interface ContainOptions {
  reason: string;
  by: string;
  restore?: string;
  url?: string;
  adminToken?: string;
}

/**
 * Stopping things, in the words somebody reaches for at 2am. Each records who asked,
 * why, and — crucially — every machine it did not reach.
 */
export function registerContainCommands(program: Command, context: CliContext): void {
  agentCommand(
    program,
    context,
    'kill',
    CONTAINMENT_KIND.KILL,
    'Stop one agent everywhere: revoke its leases, close its seams, cancel its work',
  );
  agentCommand(
    program,
    context,
    'quarantine',
    CONTAINMENT_KIND.QUARANTINE,
    'Hold one agent read-only, so it stays debuggable rather than dead',
  );

  program
    .command('panic')
    .description('Raise every environment to enforce and stop issuing capabilities')
    .requiredOption('--reason <text>', 'why — it goes on the record')
    .requiredOption('--by <who>', 'who is asking')
    .requiredOption(
      '--restore <command>',
      'the way back, required before this is expressible',
    )
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(async (options: ContainOptions) => {
      await contain(context, { kind: CONTAINMENT_KIND.PANIC, options });
    });
}

function agentCommand(
  program: Command,
  context: CliContext,
  name: string,
  kind: ContainmentKind,
  description: string,
): void {
  program
    .command(`${name} <agentId>`)
    .description(description)
    .requiredOption('--reason <text>', 'why — it goes on the record')
    .requiredOption('--by <who>', 'who is asking')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(async (agentId: string, options: ContainOptions) => {
      await contain(context, { kind, subjectId: agentId, options });
    });
}

async function contain(
  context: CliContext,
  input: { kind: ContainmentKind; subjectId?: string; options: ContainOptions },
): Promise<void> {
  const { out, style } = context;
  const { client } = await context.connect(input.options);
  const action: ContainmentAction = await client.contain({
    kind: input.kind,
    reason: input.options.reason,
    authorId: input.options.by,
    ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
    ...(input.options.restore === undefined
      ? {}
      : { restorePath: input.options.restore }),
  });

  out.line(style.bold(`${input.kind.toUpperCase()}  ${action.id}`));
  out.line('');
  out.line(`  leases revoked      ${action.effects.leasesRevoked}`);
  out.line(`  seams closed        ${action.effects.seamsClosed}`);
  out.line(`  machines reached    ${action.effects.installsReached}`);

  if (action.unreached.length === 0) {
    out.line('');
    out.line(style.ok('  Every machine acknowledged it.'));
    return;
  }

  /* A killed agent on a laptop that is asleep is not killed yet, and a non-zero exit
     is what stops a script from treating a partial containment as a finished one. */
  out.line('');
  out.line(style.warn(`  NOT REACHED — this is not finished:`));
  for (const install of action.unreached) out.line(`    ${install.hostLabel}`);
  out.line('');
  out.line(
    style.dim('  Re-run when those machines are back. Until then, they are ungoverned.'),
  );
  process.exitCode = EXIT_PARTIAL;
}
