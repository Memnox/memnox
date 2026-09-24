/** `memnox mcp`: routing this machine's MCP servers through the proxy, and putting them back. */
import { homedir } from 'node:os';
import type { Command } from 'commander';
import { planWrap, PROBATION_KIND, PROXY_BINARY, type WrapPlan } from '@memnox/core';
import type { CliContext } from '../cli-context';
import { TONE } from '../flow';
import { onPath } from '../on-path';
import {
  isProxyOnPath,
  readConfigs,
  writeRelaunches,
  type BinaryResolver,
  type ConfigFile,
} from '../mcp/server-configs';
import { unwrapEveryServer } from '../mcp/wrap-servers';
import { markMcp } from '../keeper/kept';
import { runTrust } from '../probation-view';
import { runSessionToggle } from '../session-tools/session-toggle';

/** What `mcp` reads from outside itself, each injected so a test can pin it. */
interface McpDeps {
  home: () => string;
  resolveBinary: BinaryResolver;
  project: () => string;
}

interface WrapOptions {
  dryRun?: boolean;
}

export function registerMcpCommand(
  program: Command,
  context: CliContext,
  overrides: Partial<McpDeps> = {},
): void {
  const deps: McpDeps = {
    home: homedir,
    resolveBinary: onPath,
    project: () => process.cwd(),
    ...overrides,
  };
  const mcp = program
    .command('mcp')
    .description('Route this machine’s MCP servers through the Memnox proxy');

  mcp
    .command('wrap')
    .description('Repoint every MCP server at the proxy, keeping a backup')
    .option('--dry-run', 'print what would change and write nothing')
    .action(async (options: WrapOptions) => runWrap(context, deps, options));

  mcp
    .command('unwrap')
    .description('Put every MCP server back the way it was')
    .action(async () => runUnwrap(context, deps));

  mcp
    .command('session <state>')
    .description(
      'Turn the Memnox tools an agent can call from inside a session on or off',
    )
    .action(async (state: string) =>
      runSessionToggle(context, deps.home(), state, deps.resolveBinary),
    );

  mcp
    .command('trust <server>')
    .description("End a server's probation now, so only your rules decide what it does")
    .action(async (server: string) =>
      runTrust({
        context,
        home: deps.home(),
        kind: PROBATION_KIND.MCP_SERVER,
        name: server,
        now: new Date(),
      }),
    );
}

/** Repoints every MCP server at the proxy, keeping a backup of each config. */
async function runWrap(
  context: CliContext,
  deps: McpDeps,
  options: WrapOptions,
): Promise<void> {
  const { flow, style } = context;
  const dryRun = options.dryRun === true;
  flow.open('memnox mcp wrap');
  if (!dryRun && !isProxyOnPath(deps.resolveBinary)) {
    throw new Error(
      `"${PROXY_BINARY}" is not on PATH, so wrapping would stop your agents starting at all.\n` +
        'Install the CLI first (npm install -g memnox), then run this again.',
    );
  }
  const configs = await readConfigs(deps.home(), deps.project());
  if (configs.length === 0) {
    flow.close('No MCP config on this machine, so there is nothing to wrap.');
    return;
  }

  const wrapped = await wrapEach(context, deps, configs, dryRun);

  if (dryRun) {
    flow.close(`${wrapped} server(s) would be wrapped. Nothing was changed.`);
    return;
  }
  await markMcp(deps.home(), true);
  flow.close(
    wrapped === 0
      ? 'Every server was already wrapped.'
      : style.ok(`${wrapped} server(s) wrapped.`),
  );
  if (wrapped > 0) flow.hint('Restart your agent, then "memnox mcp unwrap" to undo.');
}

/** Shows each config's plan and, unless this is a dry run, writes it; answers how many. */
async function wrapEach(
  context: CliContext,
  deps: McpDeps,
  configs: readonly ConfigFile[],
  dryRun: boolean,
): Promise<number> {
  let wrapped = 0;
  for (const file of configs) {
    const plan = planWrap(file.servers, file.agent);
    if (plan.wrap.length === 0 && plan.alreadyWrapped.length === 0) continue;
    renderPlan(context, file, plan);
    wrapped += plan.wrap.length;
    if (!dryRun && plan.wrap.length > 0) {
      await writeRelaunches(deps.home(), file, plan.wrap);
    }
  }
  return wrapped;
}

/** One config's servers, and what wrapping does or does not do to each. */
function renderPlan(context: CliContext, file: ConfigFile, plan: WrapPlan): void {
  context.flow.list(file.path, [
    ...plan.wrap.map((each) => ({
      tone: TONE.OK,
      text: `${each.name}  ${each.before.command} → proxy`,
    })),
    ...plan.alreadyWrapped.map((each) => ({
      tone: TONE.DIM,
      text: `${each} is already wrapped`,
    })),
    // A URL upstream has no command line to repoint, and saying so beats silence.
    ...file.urlOnly.map((each) => ({
      tone: TONE.DIM,
      text: `${each} is declared by URL, so it is left alone`,
    })),
  ]);
}

/** Puts every wrapped server back the way its own config had it. */
async function runUnwrap(context: CliContext, deps: McpDeps): Promise<void> {
  const { flow, style } = context;
  flow.open('memnox mcp unwrap');
  const restored = await unwrapEveryServer(deps.home(), deps.project(), context);
  // Written down, or the daemon wraps them all again on its next pass.
  await markMcp(deps.home(), false);
  flow.close(
    restored === 0
      ? 'Nothing here was wrapped, so nothing was changed.'
      : style.ok(`${restored} server(s) restored.`),
  );
  if (restored > 0) flow.hint('Restart your agent.');
}
