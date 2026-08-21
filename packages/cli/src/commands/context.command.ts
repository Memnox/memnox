import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { DEFAULT_BASE_URL } from '../defaults';
import { resolveProjectId } from '../project-identity';

/** Where the command is being run; injected so tests never depend on the real cwd. */
type WorkingDirectory = () => string;

/** The pre-flight half of the gate: what governs this, before doing it. */
export function registerContextCommand(
  program: Command,
  context: CliContext,
  cwd: WorkingDirectory = () => process.cwd(),
): void {
  program
    .command('context <action> [target]')
    .description('What rules govern an action — ask before doing it')
    .option('--env <environment>', 'environment, e.g. production')
    .option(
      '--project <name>',
      'governance scope (default: the project this directory declares)',
    )
    .option('--json', 'emit the structured briefing instead of the text')
    .option('--token <token>', `agent token (default: the one from "memnox setup")`)
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .action(
      async (
        action: string,
        target: string | undefined,
        options: {
          env?: string;
          project?: string;
          json?: boolean;
          token?: string;
          url?: string;
        },
      ) => {
        const { out } = context;
        const { client, connection } = await context.connect(options);
        if (connection.token === undefined) {
          throw new Error(
            'No agent token. Pass --token, export MEMNOX_AGENT_TOKEN, or run "memnox setup" to store one.',
          );
        }

        const response = await client.context({
          action,
          target,
          environment: options.env,
          projectId: options.project ?? resolveProjectId(cwd()),
        });

        out.line(
          options.json === true
            ? JSON.stringify(response.briefing, null, 2)
            : response.text,
        );
      },
    );
}
