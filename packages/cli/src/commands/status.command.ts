import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { DEFAULT_BASE_URL, DEFAULT_POLICY_FILE } from '../defaults';
import { resolveProjectId } from '../project-identity';

const RECENT_WINDOW_EVENTS = 200;

/** Where the command is being run; injected so tests never depend on the real cwd. */
type WorkingDirectory = () => string;

/**
 * The "is this thing on?" command. Every other answer took three invocations —
 * one for the runtime, one for the rules, one for what is waiting — and a new
 * user does not yet know which three.
 */
export function registerStatusCommand(
  program: Command,
  context: CliContext,
  cwd: WorkingDirectory = () => process.cwd(),
): void {
  program
    .command('status')
    .description('Is the runtime up, which rules are in force, what is waiting')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(async (options: { url?: string; adminToken?: string }) => {
      const { out } = context;
      const { client, connection } = await context.connect(options);

      const [policies, pending, recent] = await Promise.all([
        client.policies(),
        client.pendingApprovals(),
        client.recentAudit(RECENT_WINDOW_EVENTS),
      ]);

      const withheld = recent.filter((event) => event.withheldEffect !== undefined);
      const project = resolveProjectId(cwd());

      out.line(`Runtime   : ${connection.url}`);
      out.line(`Policies  : ${policies.policies.length} (version ${policies.version})`);
      if (project !== undefined) out.line(`Project   : ${project}`);
      out.line(
        `Credential: ${connection.token === undefined ? 'none — run "memnox setup"' : `stored (${connection.tokenSource})`}`,
      );
      out.line(`Decisions : ${recent.length} recent`);
      out.line(`Waiting   : ${pending.length} approval(s)`);

      // The number that decides whether enforcing is safe yet.
      if (withheld.length > 0) {
        out.line(`Observed  : ${withheld.length} would have been stopped if enforcing`);
      }

      out.note('');
      if (connection.token === undefined) {
        out.note(`→ Set up this project:  memnox setup`);
        return;
      }
      if (pending.length > 0) out.note('→ Grant one:  memnox approve <id>');
      if (withheld.length > 0) out.note('→ See them:   memnox audit');
      if (project === undefined) {
        out.note(
          `→ No ${DEFAULT_POLICY_FILE} here — project-scoped rules will not apply.`,
        );
      }
    });
}
