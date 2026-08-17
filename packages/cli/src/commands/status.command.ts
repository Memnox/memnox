import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { DEFAULT_BASE_URL, DEFAULT_POLICY_FILE } from '../defaults';
import { findPolicyFile, resolveProjectId } from '../project-identity';

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
      const { out, style } = context;
      const { client, connection } = await context.connect(options);

      const [policies, pending, recent] = await Promise.all([
        client.policies(),
        client.pendingApprovals(),
        client.recentAudit(RECENT_WINDOW_EVENTS),
      ]);

      const withheld = recent.filter((event) => event.withheldEffect !== undefined);
      const workingDirectory = cwd();
      const policyFile = findPolicyFile(workingDirectory);
      const project = resolveProjectId(workingDirectory);

      out.line(`${style.dim('Runtime   :')} ${style.bold(connection.url)}`);
      out.line(
        `${style.dim('Policies  :')} ${policies.policies.length} (version ${policies.version})`,
      );
      if (project !== undefined) out.line(`${style.dim('Project   :')} ${project}`);
      out.line(
        `${style.dim('Credential:')} ${
          connection.token === undefined
            ? style.warn('none — run "memnox setup"')
            : `stored (${connection.tokenSource})`
        }`,
      );
      out.line(`${style.dim('Decisions :')} ${recent.length} recent`);
      out.line(
        `${style.dim('Waiting   :')} ${
          pending.length > 0
            ? style.warn(`${pending.length} approval(s)`)
            : `${pending.length} approval(s)`
        }`,
      );

      // The number that decides whether enforcing is safe yet.
      if (withheld.length > 0) {
        out.line(
          `${style.dim('Observed  :')} ${style.warn(`${withheld.length} would have been stopped if enforcing`)}`,
        );
      }

      out.note('');
      if (connection.token === undefined) {
        out.note(style.dim(`→ Set up this project:  memnox setup`));
        return;
      }
      if (pending.length > 0) out.note(style.dim('→ Grant one:  memnox approve <id>'));
      if (withheld.length > 0) out.note(style.dim('→ See them:   memnox audit'));
      // A missing file and a file that declares no project need different fixes.
      // Declaring none is only a problem when some *other* file scopes its rules
      // to a project — otherwise every rule applies and there is nothing to warn
      // about, which is the state every fresh `memnox setup` leaves behind.
      const scopedRules = policies.policies.filter(isProjectScoped).length;
      if (project === undefined && (policyFile === undefined || scopedRules > 0)) {
        out.note(
          policyFile === undefined
            ? `→ No ${DEFAULT_POLICY_FILE} here — create one:  memnox init`
            : `→ ${DEFAULT_POLICY_FILE} declares no "project:", so ${scopedRules} project-scoped rule(s) loaded here will never match.`,
        );
      }
    });
}

/** A rule that only matches requests naming its project — the wire shape is untyped. */
function isProjectScoped(policy: unknown): boolean {
  if (typeof policy !== 'object' || policy === null) return false;
  return 'project' in policy && typeof policy.project === 'string';
}
