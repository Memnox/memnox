import { Command } from 'commander';
import type { CliContext } from './cli-context';
import { CLI_VERSION } from './defaults';
import { registerScanCommand } from './commands/scan.command';
import { registerDiffCommand } from './commands/diff.command';
import { registerWatchCommand } from './commands/watch.command';
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
import { registerVerifyCommand } from './commands/verify.command';
import { registerDaemonCommand } from './commands/daemon.command';
import { registerUninstallCommand } from './commands/uninstall.command';
import { registerRunCommand } from './commands/run.command';
import { registerMcpCommand } from './commands/mcp.command';
import { registerPolicyCommand } from './commands/policy.command';

/** Builds the full command tree against a context. Tests build one with fakes. */
export function buildProgram(context: CliContext): Command {
  const program = new Command()
    .name('memnox')
    .description('Memnox — the execution trust layer for AI agents')
    .version(CLI_VERSION);

  registerScanCommand(program, context);
  registerDiffCommand(program, context);
  registerExplainCommand(program, context);
  registerProtectCommand(program, context);
  registerRunCommand(program, context);
  registerUninstallCommand(program, context);
  registerFreezeCommand(program, context);
  registerApprovalsCommand(program, context);
  registerCollisionsCommand(program, context);
  registerVerifyCommand(program, context);
  registerDaemonCommand(program, context);
  registerMcpCommand(program, context);
  registerWhyCommand(program, context);
  registerTimelineCommand(program, context);
  registerPurgeCommand(program, context);
  registerPolicyCommand(program, context);
  registerWatchCommand(program, context);
  registerDoctorCommand(program, context);
  registerConfigCommand(program, context);

  return program;
}
