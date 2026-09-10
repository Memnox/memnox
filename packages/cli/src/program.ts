import { Command } from 'commander';
import { masthead } from './banner';
import type { CliContext } from './cli-context';
import { CLI_VERSION } from './defaults';
import { registerScanCommand } from './commands/scan.command';
import { registerDiffCommand } from './commands/diff.command';
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
import { registerAutopilotCommand } from './commands/autopilot.command';
import { registerEnvCommand } from './commands/env.command';
import { registerVerifyCommand } from './commands/verify.command';
import { registerDaemonCommand } from './commands/daemon.command';
import { registerUninstallCommand } from './commands/uninstall.command';
import { registerRunCommand } from './commands/run.command';
import { registerMcpCommand } from './commands/mcp.command';
import { registerPolicyCommand } from './commands/policy.command';
import { registerLoginCommand } from './commands/login.command';
import { registerSpendCommand } from './commands/spend.command';
import { registerSyncCommand } from './commands/sync.command';
import { registerAgentsCommand } from './commands/agents.command';

/** Builds the full command tree against a context. Tests build one with fakes. */
export function buildProgram(context: CliContext): Command {
  const program = new Command()
    .name('memnox')
    .description('Memnox — the execution trust layer for AI agents')
    .version(CLI_VERSION);

  /* Once, above every command, from the one place that knows a command is about to
     run. Drawing it inside each command would mean the next one added forgets, and
     `--help` and `--version` never reach here, which is right: neither is a run. */
  program.hook('preAction', (_program, command) => {
    if (command.opts()['json'] === true) return;
    masthead(context.out, context.style);
  });

  registerScanCommand(program, context);
  registerAgentsCommand(program, context);
  registerDiffCommand(program, context);
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
  registerAutopilotCommand(program, context);
  registerEnvCommand(program, context);
  registerApprovalsCommand(program, context);
  registerCollisionsCommand(program, context);
  registerVerifyCommand(program, context);
  registerDaemonCommand(program, context);
  registerMcpCommand(program, context);
  registerWhyCommand(program, context);
  registerTimelineCommand(program, context);
  registerPurgeCommand(program, context);
  registerPolicyCommand(program, context);
  // Off until somebody runs `login`: with no account file these reach nothing.
  registerLoginCommand(program, context);
  registerSpendCommand(program, context);
  registerSyncCommand(program, context);
  registerWatchCommand(program, context);
  registerRewindCommand(program, context);
  registerCheckCommand(program, context);
  registerTraceCommand(program, context);
  registerDoctorCommand(program, context);
  registerConfigCommand(program, context);

  return program;
}
