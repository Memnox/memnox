import { homedir } from 'node:os';
import type { Command } from 'commander';
import { readAgentConfig } from '../agent-config';
import type { CliContext } from '../cli-context';
import {
  isNotConfigured,
  resolveCloud,
  SIGN_IN_HINT,
  WORKSPACE_HINT,
  type CloudResolution,
  type ResolvedCloud,
} from '../cloud-connection';
import type { CloudClientFactory } from './login.command';
import { CloudClient } from '../cloud-client';

const buildCloudClient: CloudClientFactory = (connection) => new CloudClient(connection);

const DEFAULT_TIMELINE_LIMIT = 20;
const EXIT_UNAVAILABLE = 1;

interface CloudCommandFlags {
  cloud?: string;
  token?: string;
  workspace?: string;
}

/**
 * What a developer reads from their organization without leaving the terminal.
 *
 * Both of these are answerable while the workspace runtime is unreachable — the
 * review queue is control-plane state and the timeline is a mirror — so they
 * still work from a laptop that no runtime can be dialled from.
 */
export function registerCloudCommand(
  program: Command,
  context: CliContext,
  homeDir: string = homedir(),
  buildClient: CloudClientFactory = buildCloudClient,
): void {
  const connect = async (
    flags: CloudCommandFlags,
  ): Promise<{ client: CloudClient; workspace: string } | null> => {
    const stored = await readAgentConfig(homeDir);
    const resolution: CloudResolution = resolveCloud(
      { cloudUrl: flags.cloud, cloudToken: flags.token, workspace: flags.workspace },
      stored,
      process.env,
    );
    if (isNotConfigured(resolution)) {
      context.out.line(SIGN_IN_HINT);
      process.exitCode = EXIT_UNAVAILABLE;
      return null;
    }
    const connection: ResolvedCloud = resolution;
    if (connection.workspace === undefined) {
      context.out.line(WORKSPACE_HINT);
      process.exitCode = EXIT_UNAVAILABLE;
      return null;
    }
    return { client: buildClient(connection), workspace: connection.workspace };
  };

  withCloudFlags(
    program
      .command('suggestions')
      .description('Organization decisions waiting for a human in the review queue'),
  ).action(async function (this: Command) {
    const connected = await connect(this.opts() as CloudCommandFlags);
    if (connected === null) return;

    const pending = await connected.client.suggestions(connected.workspace);
    if (pending.length === 0) {
      context.out.line('Nothing waiting for review.');
      return;
    }
    for (const suggestion of pending) {
      context.out.line(`${suggestion.id}  [${suggestion.status}]  ${suggestion.title}`);
      if (suggestion.statement !== undefined) {
        context.out.line(`  ${suggestion.statement}`);
      }
    }
    context.out.note('');
    context.out.note('A human approves one before it constrains any agent.');
  });

  withCloudFlags(
    program
      .command('timeline')
      .description('What agents and sources did across the workspace, newest first'),
  )
    .option('--limit <n>', 'entries to show', String(DEFAULT_TIMELINE_LIMIT))
    .action(async function (this: Command) {
      const flags = this.opts() as CloudCommandFlags & { limit: string };
      const connected = await connect(flags);
      if (connected === null) return;

      const entries = await connected.client.timeline(
        connected.workspace,
        Number(flags.limit),
      );
      if (entries.length === 0) {
        context.out.line('Nothing on the timeline yet.');
        return;
      }
      for (const entry of entries) {
        context.out.line(
          `${entry.occurredAt}  [${entry.kind}]  ${describe(entry.event)}`,
        );
      }
    });
}

/** Every cloud command takes the same three overrides. */
function withCloudFlags(command: Command): Command {
  return command
    .option('--cloud <url>', 'control plane base URL')
    .option('--token <token>', 'control plane API token')
    .option('--workspace <id>', 'workspace to read');
}

/**
 * One line for either shape on the timeline. Reads named fields rather than
 * chaining, so a missing one is an empty string and never a crash.
 */
function describe(event: Record<string, unknown>): string {
  const effect = text(event['effect']);
  const action = text(event['action']);
  const target = text(event['target']);
  const kind = text(event['sourceType']);
  const head = effect === '' ? kind : effect.toUpperCase();
  return [head, action, target].filter((part) => part !== '').join(' ');
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
