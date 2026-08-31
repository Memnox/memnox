import { Command } from 'commander';
import type { CliContext } from './cli-context';
import { CLI_VERSION } from './defaults';
import { registerAgentsCommand } from './commands/agents.command';
import { registerApprovalsCommand } from './commands/approvals.command';
import { registerAuditCommand } from './commands/audit.command';
import { registerCheckCommand } from './commands/check.command';
import { registerCloudCommand } from './commands/cloud.command';
import { registerDiscoverCommand } from './commands/discover.command';
import { registerDoctorCommand } from './commands/doctor.command';
import { registerHardenCommand } from './commands/harden.command';
import { registerHooksCommand } from './commands/hooks.command';
import { registerDriftCommand } from './commands/drift.command';
import { registerDraftCommand } from './commands/draft.command';
import { registerWhyCommand } from './commands/why.command';
import { registerRulesCommand } from './commands/rules.command';
import { registerEvidenceCommand } from './commands/evidence.command';
import { registerCoverageCommand } from './commands/coverage.command';
import { registerLearnCommand } from './commands/learn.command';
import { registerContainCommands } from './commands/contain.command';
import { registerCensusCommand } from './commands/census.command';
import { registerReadinessCommand } from './commands/readiness.command';
import { registerInitCommand } from './commands/init.command';
import { registerLoginCommand } from './commands/login.command';
import { registerKeysCommand } from './commands/keys.command';
import { registerMcpCommand } from './commands/mcp.command';
import { registerMemoryCommand } from './commands/memory.command';
import { registerOrgCommand } from './commands/org.command';
import { registerPolicyCommand } from './commands/policy.command';
import { registerPullCommand } from './commands/pull.command';
import { registerReplayCommand } from './commands/replay.command';
import { registerServeCommand } from './commands/serve.command';
import { registerStatusCommand } from './commands/status.command';
import { registerSetupCommand } from './commands/setup.command';
import { registerStopCommand } from './commands/stop.command';
import { registerTestCommand } from './commands/test.command';
import { registerValidateCommand } from './commands/validate.command';

/** Builds the full command tree against a context. Tests build one with fakes. */
export function buildProgram(context: CliContext): Command {
  const program = new Command()
    .name('memnox')
    .description('Memnox — the execution trust layer for AI agents')
    .version(CLI_VERSION);

  // The first four phases need no account: discovery, doctor and harden come first.
  registerDiscoverCommand(program, context);
  registerDoctorCommand(program, context);
  registerHardenCommand(program, context);
  registerHooksCommand(program, context);
  registerSetupCommand(program, context);
  registerInitCommand(program, context);
  registerServeCommand(program, context);
  registerStopCommand(program, context);
  registerStatusCommand(program, context);
  registerLoginCommand(program, context);
  registerCloudCommand(program, context);
  registerPullCommand(program, context);
  registerValidateCommand(program, context);
  registerCheckCommand(program, context);
  registerTestCommand(program, context);
  registerDriftCommand(program, context);
  registerAuditCommand(program, context);
  registerAgentsCommand(program, context);
  registerApprovalsCommand(program, context);
  registerMcpCommand(program, context);
  registerMemoryCommand(program, context);
  registerOrgCommand(program, context);
  registerReplayCommand(program, context);
  registerDraftCommand(program, context);
  registerWhyCommand(program, context);
  registerRulesCommand(program, context);
  registerEvidenceCommand(program, context);
  registerCoverageCommand(program, context);
  registerLearnCommand(program, context);
  registerContainCommands(program, context);
  registerCensusCommand(program, context);
  registerReadinessCommand(program, context);
  registerPolicyCommand(program, context);
  registerKeysCommand(program, context);

  return program;
}
