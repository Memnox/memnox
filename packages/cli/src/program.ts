import { Command, Help } from 'commander';
import { masthead } from './banner';
import type { CliContext } from './cli-context';
import { CLI_VERSION } from './defaults';
import { registerScanCommand } from './commands/scan.command';
import { registerWatchCommand } from './commands/watch.command';
import { registerRewindCommand } from './commands/rewind.command';
import { registerCheckCommand } from './commands/check.command';
import { registerTraceCommand } from './commands/trace.command';
import { registerExplainCommand } from './commands/explain.command';
import { registerConfigCommand } from './commands/config.command';
import { registerDoctorCommand } from './commands/doctor.command';
import { registerProtectCommand } from './commands/protect.command';
import { registerWhyCommand } from './commands/why.command';
import {
  registerPurgeCommand,
  registerTimelineCommand,
} from './commands/timeline.command';
import { registerApprovalsCommand } from './commands/approvals.command';
import { registerCollisionsCommand } from './commands/collisions.command';
import { registerFreezeCommand } from './commands/freeze.command';
import { registerLockCommand } from './commands/lock.command';
import { registerResumeCommand } from './commands/resume.command';
import { registerClaimsCommand } from './commands/claims.command';
import { registerBudgetCommand } from './commands/budget.command';
import { registerNextCommand } from './commands/next.command';
import { registerReportCommand } from './commands/report.command';
import { registerSkillsCommand } from './commands/skills.command';
import { registerEnvCommand } from './commands/env.command';
import { registerDaemonCommand } from './commands/daemon.command';
import { registerUninstallCommand } from './commands/uninstall.command';
import { registerRunCommand } from './commands/run.command';
import { registerMcpCommand } from './commands/mcp.command';
import { registerPolicyCommand } from './commands/policy.command';
import { registerLoginCommand } from './commands/login.command';
import { registerSyncCommand } from './commands/sync.command';
import { registerAgentsCommand } from './commands/agents.command';
import { registerSetupCommand } from './commands/setup.command';

/**
 * The commands `--help` shows, in the order somebody meets the product.
 *
 * Everything else still runs and still has its own `--help`; it is simply not
 * on the first page. Forty commands in one list is a list nobody reads, and a
 * person who cannot find the four that matter concludes the product is for
 * somebody else. So the front page is the story: see the machine, name the
 * agents, close the gaps, run one, read what happened.
 */
const SPINE: readonly string[] = [
  'scan',
  'setup',
  'agents',
  'explain',
  'protect',
  'run',
  'watch',
  'approvals',
  'approve',
  'deny',
  'why',
  'timeline',
  'next',
  'login',
  'logout',
  'whoami',
  'sync',
  'doctor',
  'config',
  'uninstall',
];

/** Builds the full command tree against a context. Tests build one with fakes. */
export function buildProgram(context: CliContext): Command {
  const program = new Command()
    .name('memnox')
    .description('Memnox, the execution trust layer for AI agents')
    .version(CLI_VERSION);

  /* Once, above every command, from the one place that knows a command is about to
     run. Drawing it inside each command would mean the next one added forgets, and
     `--help` and `--version` never reach here, which is right: neither is a run. */
  program.hook('preAction', (_program, command) => {
    if (command.opts()['json'] === true) return;
    masthead(context.out, context.style);
  });

  registerScanCommand(program, context);
  registerSetupCommand(program, context);
  registerAgentsCommand(program, context);
  registerExplainCommand(program, context);
  registerProtectCommand(program, context);
  registerRunCommand(program, context);
  registerUninstallCommand(program, context);
  registerFreezeCommand(program, context);
  registerLockCommand(program, context);
  registerResumeCommand(program, context);
  registerClaimsCommand(program, context);
  registerBudgetCommand(program, context);
  registerNextCommand(program, context);
  registerReportCommand(program, context);
  registerSkillsCommand(program, context);
  registerEnvCommand(program, context);
  registerApprovalsCommand(program, context);
  registerCollisionsCommand(program, context);
  registerDaemonCommand(program, context);
  registerMcpCommand(program, context);
  registerWhyCommand(program, context);
  registerTimelineCommand(program, context);
  registerPurgeCommand(program, context);
  registerPolicyCommand(program, context);
  // Off until somebody runs `login`: with no account file these reach nothing.
  registerLoginCommand(program, context);
  registerSyncCommand(program, context);
  registerWatchCommand(program, context);
  registerRewindCommand(program, context);
  registerCheckCommand(program, context);
  registerTraceCommand(program, context);
  registerDoctorCommand(program, context);
  registerConfigCommand(program, context);

  showSpine(program);

  return program;
}

/**
 * Keeps the front page to the spine, and says where the rest went.
 *
 * Through `configureHelp` rather than by marking each command hidden, so the
 * decision about what a newcomer sees lives in one list here instead of being
 * spread across thirty registration functions where the next one added forgets.
 */
function showSpine(program: Command): void {
  const spine = new Set(SPINE);
  program.configureHelp({
    visibleCommands(command) {
      const all = Help.prototype.visibleCommands.call(this, command);
      // Only the top level: a subcommand list is already short enough to read.
      if (command !== program) return all;
      return all.filter((each) => spine.has(each.name()) || each.name() === 'help');
    },
  });

  const rest = () =>
    program.commands
      .map((each) => each.name())
      .filter((name) => !spine.has(name) && name !== 'help')
      .sort();

  program.addHelpText(
    'after',
    () =>
      `\nLess common commands, each with its own help:\n  ${rest().join('  ')}\n` +
      `\n  memnox help <command>   what one of them does\n`,
  );
}
