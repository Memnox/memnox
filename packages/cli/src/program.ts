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
