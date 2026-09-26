import { homedir } from 'node:os';
import { Command } from 'commander';
import { renderMasthead } from './banner';
import type { CliContext } from './cli-context';
import { CLI_VERSION } from './defaults';
import { configureShortHelp, HELP_COMMAND } from './help';
import { registerScanCommand } from './commands/scan.command';
import { registerWatchCommand } from './commands/watch.command';
import { registerRewindCommand } from './commands/rewind.command';
import { registerCheckCommand } from './commands/check.command';
import { registerTraceCommand } from './commands/trace.command';
import { registerReplayCommand } from './commands/replay.command';
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
import { registerRepoCommand } from './commands/repo.command';
import { registerTaskCommand } from './commands/task.command';
import { registerModeCommand } from './commands/mode.command';
import { unwrapEveryServer } from './mcp/wrap-servers';
import { registerPolicyCommand } from './commands/policy.command';
import { registerLoginCommand } from './commands/login.command';
import { registerSyncCommand } from './commands/sync.command';
import { registerAgentsCommand } from './commands/agents.command';
import { registerSetupCommand } from './commands/setup.command';
import { registerStatusCommand } from './commands/status.command';
import { registerStartCommand, registerStopCommand } from './commands/stop.command';
import { registerUpdateCommand } from './commands/update.command';

/**
 * The commands `--help` shows, in the order somebody reaches for them at a terminal. The
 * rest happens in the agent session and stays wired, listed by `memnox help --all`.
 */
const SPINE: readonly string[] = [
  'setup',
  'status',
  'rewind',
  'doctor',
  'stop',
  'start',
  'update',
  // The one cloud step, and a person's to take, so it stays on the front page.
  'login',
];

/**
 * Bare `memnox` is the scan on a machine nobody has set up, and the status view once
 * somebody has, because the first question is what is here and every later one is
 * whether it is still held.
 */
export function withDefaultCommand(argv: readonly string[], setUp: boolean): string[] {
  const bare = argv.length <= 2;
  return bare && setUp ? [...argv, 'status'] : [...argv];
}

/** Builds the full command tree against a context. Tests build one with fakes. */
export function buildProgram(context: CliContext): Command {
  const program = new Command()
    .name('memnox')
    .description('Memnox, the execution trust layer for AI agents')
    .version(CLI_VERSION);

  // Drawn once here rather than in each command, so the next one added cannot forget it;
  // `--help` and `--version` never reach this, which is right since neither is a run.
  program.hook('preAction', (_program, command) => {
    if (command.opts()['json'] === true || command.name() === HELP_COMMAND) return;
    renderMasthead(context.out, context.style);
  });

  // Closed once below every command, so one that returns early never leaves the gutter open.
  program.hook('postAction', () => {
    context.flow.end();
  });

  registerCommands(program, context);
  configureShortHelp(program, SPINE);
  return program;
}

/** What a person types at a terminal, first, so `help --all` opens with them too. */
function registerTerminalCommands(program: Command, context: CliContext): void {
  registerScanCommand(program, context);
  // How a person shapes the work: the mode, the task, and what a clone may do.
  registerModeCommand(program, context);
  registerTaskCommand(program, context);
  registerRepoCommand(program, context);
  registerSetupCommand(program, context);
  registerStatusCommand(program, context);
  registerStopCommand(program, context);
  registerStartCommand(program, context);
  registerUpdateCommand(program, context);
}

function registerCommands(program: Command, context: CliContext): void {
  registerTerminalCommands(program, context);
  registerAgentsCommand(program, context);
  registerExplainCommand(program, context);
  registerProtectCommand(program, context);
  registerRunCommand(program, context);
  // Wired, or the agent configs keep calling a proxy the next `npm uninstall` removes.
  registerUninstallCommand(program, context, {
    unwrap: () => unwrapEveryServer(homedir(), process.cwd(), context),
  });
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
  registerReplayCommand(program, context);
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
}
