import { homedir } from 'node:os';
import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { DEFAULT_BASE_URL } from '../defaults';
import { McpInstaller, SUPPORTED_MCP_CLIENTS } from '../mcp-installer';
import { LineBuffer, McpServer, parseMessage, serializeMessage } from '../mcp/mcp-server';
import { resolveProjectId } from '../project-identity';

/** stdin/stdout as an argument, so a test drives the server without a process. */
interface StdioHost {
  onInput(handler: (chunk: string) => void): void;
  write(payload: string): void;
  onClose(handler: () => void): void;
}

const processStdio: StdioHost = {
  onInput: (handler) => {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', handler);
  },
  write: (payload) => process.stdout.write(payload),
  onClose: (handler) => process.stdin.on('end', handler),
};

/** Memnox as an MCP server, so an agent can ask without per-client wiring. */
export function registerMcpCommand(
  program: Command,
  context: CliContext,
  installer = new McpInstaller(homedir()),
  stdio: StdioHost = processStdio,
  cwd: () => string = () => process.cwd(),
): void {
  const mcp = program
    .command('mcp')
    .description('Run Memnox as an MCP server so agents can ask before they act')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--token <token>', 'agent token (default: the one from "memnox setup")')
    .action(async function (this: Command) {
      const options = this.opts() as { url?: string; token?: string };
      const { client, connection } = await context.connect(options);
      const server = new McpServer({
        client,
        runtimeUrl: connection.url,
        projectId: resolveProjectId(cwd()),
      });

      const buffer = new LineBuffer();
      await new Promise<void>((resolve) => {
        stdio.onClose(resolve);
        stdio.onInput((chunk) => {
          for (const line of buffer.push(chunk)) {
            const message = parseMessage(line);
            if (message === null) continue;
            // Errors are turned into tool results upstream; anything reaching
            // here is a bug, and a dead server is worse than a logged one.
            void server
              .handle(message)
              .then((reply) => {
                if (reply !== null) stdio.write(serializeMessage(reply));
              })
              .catch((err: unknown) => {
                context.out.note(`[memnox] mcp handler failed: ${String(err)}`);
              });
          }
        });
      });
    });

  mcp
    .command('install [client]')
    .description(
      `Register Memnox with an MCP client (${SUPPORTED_MCP_CLIENTS.join('|')}); omit to install for all detected`,
    )
    .action(async (client: string | undefined) => {
      const reports =
        client === undefined
          ? await installer.installDetected()
          : [await installer.install(client)];

      if (reports.length === 0) {
        context.out.line('No MCP client config found — nothing to install.');
        context.out.note('');
        context.out.note(`→ Supported: ${SUPPORTED_MCP_CLIENTS.join(', ')}`);
        return;
      }
      for (const report of reports) {
        context.out.line(
          report.installed
            ? `Registered Memnox with ${report.client} (${report.path})`
            : `${report.client} already has Memnox registered`,
        );
      }
      context.out.note('');
      context.out.note('→ Restart the client, then ask it: "what rules apply here?"');
    });

  mcp
    .command('uninstall <client>')
    .description(`Remove Memnox from an MCP client (${SUPPORTED_MCP_CLIENTS.join('|')})`)
    .action(async (client: string) => {
      const removed = await installer.uninstall(client);
      context.out.line(
        removed ? `Removed Memnox from ${client}` : `${client} had no Memnox entry`,
      );
    });
}
