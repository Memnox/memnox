import { Command } from 'commander';
import type { CliContext } from './cli-context';
import { CLI_VERSION } from './defaults';
import { registerAgentsCommand } from './commands/agents.command';
import { registerApprovalsCommand } from './commands/approvals.command';
import { registerAuditCommand } from './commands/audit.command';
import { registerCheckCommand } from './commands/check.command';
import { registerCloudCommand } from './commands/cloud.command';
import { registerContextCommand } from './commands/context.command';
import { registerComplianceCommand } from './commands/compliance.command';
import { registerCiCommand } from './commands/ci.command';
import { registerDraftCommand } from './commands/draft.command';
import { registerExplainCommand } from './commands/explain.command';
import { registerGraphCommand } from './commands/graph.command';
import { registerGraphifyCommand } from './commands/graphify.command';
import { registerHookCommand } from './commands/hook.command';
import { registerInitCommand } from './commands/init.command';
import { registerLoginCommand } from './commands/login.command';
import { registerKeysCommand } from './commands/keys.command';
import { registerInsightsCommand } from './commands/insights.command';
import { registerIntentCommand } from './commands/intent.command';
import { registerMcpCommand } from './commands/mcp.command';
import { registerMemoryCommand } from './commands/memory.command';
import { registerPolicyCommand } from './commands/policy.command';
import { registerProtectCommand } from './commands/protect.command';
import { registerPullCommand } from './commands/pull.command';
import { registerQuickstartCommand } from './commands/quickstart.command';
import { registerReplayCommand } from './commands/replay.command';
import { registerReportCommand } from './commands/report.command';
import { registerServeCommand } from './commands/serve.command';
import { registerStatusCommand } from './commands/status.command';
import { registerSetupCommand } from './commands/setup.command';
import { registerValidateCommand } from './commands/validate.command';

/** Builds the full command tree against a context. Tests build one with fakes. */
export function buildProgram(context: CliContext): Command {
  const program = new Command()
    .name('memnox')
    .description('Memnox — the execution trust layer for AI agents')
    .version(CLI_VERSION);

  registerSetupCommand(program, context);
  registerQuickstartCommand(program, context);
  registerInitCommand(program, context);
  registerServeCommand(program, context);
  registerStatusCommand(program, context);
  registerLoginCommand(program, context);
  registerCloudCommand(program, context);
  registerPullCommand(program, context);
  registerValidateCommand(program, context);
  registerCheckCommand(program, context);
  registerContextCommand(program, context);
  registerAuditCommand(program, context);
  registerAgentsCommand(program, context);
  registerApprovalsCommand(program, context);
  registerMcpCommand(program, context);
  registerMemoryCommand(program, context);
  registerReplayCommand(program, context);
  registerReportCommand(program, context);
  registerInsightsCommand(program, context);
  registerDraftCommand(program, context);
  registerHookCommand(program, context);
  registerProtectCommand(program, context);
  registerCiCommand(program, context);
  registerExplainCommand(program, context);
  registerGraphCommand(program, context);
  registerGraphifyCommand(program, context);
  registerPolicyCommand(program, context);
  registerKeysCommand(program, context);
  registerComplianceCommand(program, context);
  registerIntentCommand(program, context);

  return program;
}
