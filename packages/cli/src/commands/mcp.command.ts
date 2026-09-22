import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import {
  CONFIG_FORMAT,
  formatOf,
  MCP_CONFIG_LOCATIONS,
  planUnwrap,
  planUpgrade,
  planWrap,
  PROXY_BINARY,
  readTextServers,
  rewriteTextServers,
  serversKeyOf,
  type ConfigFormat,
  type DiscoveredAgentKind,
  type ServerLaunch,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { TONE } from '../flow';
import { backupPathFor } from '../memnox-paths';
import { onPath } from '../on-path';

interface ConfigFile {
  path: string;
  raw: string;
  format: ConfigFormat;
  /** Only a JSON config carries these; a text one is edited in place instead. */
  config?: Record<string, unknown>;
  key?: string;
  servers: Record<string, ServerLaunch>;
  /** Servers declared by URL. Named so a run can say what it skipped and why. */
  urlOnly: string[];
  /** The agent these servers belong to, written into each wrapped line. */
  agent?: DiscoveredAgentKind;
}

async function readConfigs(home: string, project: string): Promise<ConfigFile[]> {
  const found: ConfigFile[] = [];
  // One list, shared with the detectors and the wiring check, or they drift apart.
  const places = MCP_CONFIG_LOCATIONS.map((each) => ({
    path: join(each.scope === 'home' ? home : project, each.relative),
    owner: each.agent === undefined ? {} : { agent: each.agent },
  }));
  for (const { path, owner } of places) {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      // A config this machine does not have is the ordinary case, not a failure.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }

    const format = formatOf(path);
    if (format !== CONFIG_FORMAT.JSON) {
      const { servers, urlOnly } = readTextServers(format, raw);
      if (Object.keys(servers).length === 0 && urlOnly.length === 0) continue;
      found.push({ path, raw, format, servers, urlOnly, ...owner });
      continue;
    }

    let config: Record<string, unknown>;
    try {
      config = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Never rewrite a file we could not parse: we would lose what it held.
      continue;
    }
    const key = serversKeyOf(config);
    if (key === null) continue;
    found.push({
      path,
      raw,
      format,
      config,
      key,
      servers: config[key] as Record<string, ServerLaunch>,
      urlOnly: [],
      ...owner,
    });
  }
  return found;
}

/**
 * Backup first, always. The failure that matters is an editor that will not start.
 *
 * A JSON config is written whole; a TOML or YAML one has its two launch lines replaced
 * and every other byte copied through, so comments and key order survive the round trip.
 */
async function writeConfig(
  home: string,
  file: ConfigFile,
  servers: Record<string, ServerLaunch>,
  changed: Record<string, ServerLaunch>,
): Promise<void> {
  const backup = backupPathFor(home, file.path);
  await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
  await copyFile(file.path, backup);

  if (file.format !== CONFIG_FORMAT.JSON) {
    await writeFile(
      file.path,
      rewriteTextServers(file.format, file.raw, changed),
      'utf8',
    );
    return;
  }
  const next = { ...file.config, [file.key as string]: servers };
  await writeFile(file.path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

/**
 * Wrapping points every server at a binary. If that binary is not on PATH the agent
 * starts nothing at all, which is a worse failure than being ungoverned — so it is
 * checked before a single config is touched, not discovered afterwards.
 */
function proxyOnPath(resolve: (binary: string) => boolean = defaultResolve): boolean {
  return resolve(PROXY_BINARY);
}

const defaultResolve = (binary: string): boolean => onPath(binary);

export function registerMcpCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
  resolveBinary: (binary: string) => boolean = defaultResolve,
  project: () => string = () => process.cwd(),
): void {
  const mcp = program
    .command('mcp')
    .description('Route this machine’s MCP servers through the Memnox proxy');

  mcp
    .command('wrap')
    .description('Repoint every MCP server at the proxy, keeping a backup')
    .option('--dry-run', 'print what would change and write nothing')
    .action(async (options: { dryRun?: boolean }) => {
      const { flow, style } = context;
      flow.open('memnox mcp wrap');
      if (options.dryRun !== true && !proxyOnPath(resolveBinary)) {
        throw new Error(
          `"${PROXY_BINARY}" is not on PATH, so wrapping would stop your agents starting at all.\n` +
            'Install the CLI first (npm install -g memnox), then run this again.',
        );
      }
      const configs = await readConfigs(home(), project());
      if (configs.length === 0) {
        flow.close('No MCP config on this machine, so there is nothing to wrap.');
        return;
      }

      let wrapped = 0;
      for (const file of configs) {
        const plan = planWrap(file.servers, file.agent);
        if (plan.wrap.length === 0 && plan.alreadyWrapped.length === 0) continue;

        flow.list(file.path, [
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
        wrapped += plan.wrap.length;

        if (options.dryRun === true || plan.wrap.length === 0) continue;
        const next = { ...file.servers };
        const changed: Record<string, ServerLaunch> = {};
        for (const each of plan.wrap) {
          next[each.name] = each.after;
          changed[each.name] = each.after;
        }
        await writeConfig(home(), file, next, changed);
      }

      if (options.dryRun === true) {
        flow.close(`${wrapped} server(s) would be wrapped. Nothing was changed.`);
        return;
      }
      flow.close(
        wrapped === 0
          ? 'Every server was already wrapped.'
          : style.ok(`${wrapped} server(s) wrapped.`),
      );
      if (wrapped > 0) {
        flow.hint('Restart your agent, then "memnox mcp unwrap" to undo.');
      }
    });

  mcp
    .command('unwrap')
    .description('Put every MCP server back the way it was')
    .action(async () => {
      const { flow, style } = context;
      flow.open('memnox mcp unwrap');
      const restored = await unwrapEveryServer(home(), project(), context);
      flow.close(
        restored === 0
          ? 'Nothing here was wrapped, so nothing was changed.'
          : style.ok(`${restored} server(s) restored.`),
      );
      if (restored > 0) flow.hint('Restart your agent.');
    });
}

/**
 * Wraps what is there, for `setup` to call rather than tell somebody to.
 *
 * The same reasoning as `unwrapEveryServer` below: leaving a person to run a
 * second command is the trap. A guided run that enrolled the machine, wired the
 * interceptors and then said nothing about MCP left every outward tool call (the
 * message, the issue, the deploy) going straight out with nothing to compare it
 * against another agent's.
 *
 * Silent, and the caller reports the count. Skipped where the proxy is not on
 * PATH, because wrapping onto a binary that is not there stops agents starting
 * at all, which is the one failure worse than not wrapping.
 */
export async function wrapEveryServer(
  home: string,
  project: string,
  resolveBinary: (binary: string) => boolean = defaultResolve,
): Promise<{ wrapped: number; skipped: boolean }> {
  if (!proxyOnPath(resolveBinary)) return { wrapped: 0, skipped: true };
  const configs = await readConfigs(home, project);
  let wrapped = 0;

  for (const file of configs) {
    const plan = planWrap(file.servers, file.agent);
    /* And the lines an older version wrapped without the agent's name, so a
       refusal on another machine names this agent without a second command. */
    const upgrades = planUpgrade(file.servers, file.agent);
    if (plan.wrap.length === 0 && upgrades.length === 0) continue;
    const next = { ...file.servers };
    const changed: Record<string, ServerLaunch> = {};
    for (const each of [...plan.wrap, ...upgrades]) {
      next[each.name] = each.after;
      changed[each.name] = each.after;
    }
    await writeConfig(home, file, next, changed);
    wrapped += plan.wrap.length;
  }
  return { wrapped, skipped: false };
}

/**
 * Puts every wrapped server back, and answers how many.
 *
 * Lifted out of the subcommand so `uninstall` can call the same code rather than
 * print an instruction. Leaving a person to run a second command was the trap:
 * `uninstall` removed the interceptors, said "nothing of Memnox is left", and left
 * three agent configs invoking `memnox-mcp-proxy`. Remove the package after that
 * and every wrapped server fails to start, with the command that would fix it
 * gone from the machine.
 *
 * The original command is read out of the wrapped entry rather than out of the
 * backup, which is what lets this run after `--purge` has deleted the backups.
 */
export async function unwrapEveryServer(
  home: string,
  project: string,
  context: CliContext,
): Promise<number> {
  const configs = await readConfigs(home, project);
  let restored = 0;

  for (const file of configs) {
    const { restore } = planUnwrap(file.servers);
    if (restore.length === 0) continue;

    context.flow.list(
      file.path,
      restore.map((each) => ({
        tone: TONE.OK,
        text: `${each.name}  proxy → ${each.after.command}`,
      })),
    );
    restored += restore.length;

    const next = { ...file.servers };
    const changed: Record<string, ServerLaunch> = {};
    for (const each of restore) {
      next[each.name] = each.after;
      changed[each.name] = each.after;
    }
    await writeConfig(home, file, next, changed);
  }
  return restored;
}
