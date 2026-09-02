import type { Command } from 'commander';
import {
  CONTAINMENT_KIND,
  type ContainmentAction,
  type ContainmentKind,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { DEFAULT_BASE_URL } from '../defaults';

const EXIT_PARTIAL = 4;

/** What holding the credential means, in each command's own words. */
const HELD_BY: Record<ContainmentKind, string> = {
  [CONTAINMENT_KIND.KILL]: 'suspended',
  [CONTAINMENT_KIND.QUARANTINE]: 'held read-only',
  [CONTAINMENT_KIND.PANIC]: 'suspended',
  [CONTAINMENT_KIND.RESTORE]: 'released',
};

const ACKNOWLEDGED: Record<ContainmentKind, string> = {
  [CONTAINMENT_KIND.KILL]: '  Held, and every machine acknowledged it.',
  [CONTAINMENT_KIND.QUARANTINE]: '  Read-only, and every machine acknowledged it.',
  [CONTAINMENT_KIND.PANIC]: '  Every machine acknowledged it.',
  [CONTAINMENT_KIND.RESTORE]: '  Every machine acknowledged it.',
};

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
    'Stop one agent everywhere: suspend its credential, revoke its leases, close its seams',
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
  out.line(`  seams closed        ${action.effects.seamsClosed}`);
  if (input.subjectId !== undefined) {
    out.line(
      `  credential          ${action.effects.credentialsHeld > 0 ? HELD_BY[input.kind] : style.warn('NOT held')}`,
    );
  }
  // Raising every environment is the whole of what panic does; printing zeros and
  // nothing else left the one real effect invisible.
  if (input.kind === CONTAINMENT_KIND.PANIC) {
    out.line(`  environments raised ${action.effects.environmentsRaised}`);
  }
  out.line(`  machines reached    ${action.effects.installsReached}`);

  /* A credential still live is the same class of lie as a machine not reached: the
     next request from that agent walks straight past a containment reported as done. */
  if (input.subjectId !== undefined && action.effects.credentialsHeld === 0) {
    out.line('');
    out.line(style.warn('  THE AGENT IS NOT HELD — this is not finished:'));
    out.line(`    ${input.subjectId} still answers to its own token.`);
    out.line(style.dim('    Check the id, then re-run. Until then, it is ungoverned.'));
    process.exitCode = EXIT_PARTIAL;
    return;
  }

  if (action.unreached.length === 0) {
    out.line('');
    out.line(style.ok(ACKNOWLEDGED[input.kind]));
    if (input.subjectId !== undefined) {
      out.note('');
      out.note(style.dim(`→ The way back:  memnox agents activate ${input.subjectId}`));
    }
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
