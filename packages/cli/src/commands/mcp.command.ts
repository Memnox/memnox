import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import {
  CONFIG_FORMAT,
  formatOf,
  MCP_CONFIG_LOCATIONS,
  planUnwrap,
  planWrap,
  PROXY_BINARY,
  readTextServers,
  rewriteTextServers,
  serversKeyOf,
  type ConfigFormat,
  type ServerLaunch,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { backupPathFor } from '../memnox-paths';

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
}

async function readConfigs(home: string, project: string): Promise<ConfigFile[]> {
  const found: ConfigFile[] = [];
  // One list, shared with the detectors and the wiring check, or they drift apart.
  const paths = MCP_CONFIG_LOCATIONS.map((each) =>
    join(each.scope === 'home' ? home : project, each.relative),
  );
  for (const path of paths) {
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
      found.push({ path, raw, format, servers, urlOnly });
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

const defaultResolve = (binary: string): boolean => {
  try {
    execFileSync('command', ['-v', binary], { stdio: 'ignore', shell: true });
    return true;
  } catch {
    // Not on PATH, which is the whole thing this check exists to catch.
    return false;
  }
};

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
      if (options.dryRun !== true && !proxyOnPath(resolveBinary)) {
        throw new Error(
          `"${PROXY_BINARY}" is not on PATH, so wrapping would stop your agents starting at all.\n` +
            'Install the CLI first (npm install -g memnox), then run this again.',
        );
      }
      const configs = await readConfigs(home(), project());
      if (configs.length === 0) {
        context.out.line('No MCP config on this machine, so there is nothing to wrap.');
        return;
      }

      let wrapped = 0;
      for (const file of configs) {
        const plan = planWrap(file.servers);
        for (const each of plan.alreadyWrapped) {
          context.out.note(`${file.path}: ${each} is already wrapped`);
        }
        if (plan.wrap.length === 0) continue;

        context.out.line(file.path);
        for (const each of plan.wrap) {
          context.out.line(`  ${each.name}  ${each.before.command} → proxy`);
        }
        // A URL upstream has no command line to repoint, and saying so beats silence.
        for (const each of file.urlOnly) {
          context.out.note(
            `${file.path}: ${each} is declared by URL, so it is left alone`,
          );
        }
        wrapped += plan.wrap.length;

        if (options.dryRun === true) continue;
        const next = { ...file.servers };
        const changed: Record<string, ServerLaunch> = {};
        for (const each of plan.wrap) {
          next[each.name] = each.after;
          changed[each.name] = each.after;
        }
        await writeConfig(home(), file, next, changed);
      }

      context.out.line('');
      if (options.dryRun === true) {
        context.out.line(`${wrapped} server(s) would be wrapped. Nothing was changed.`);
        return;
      }
      context.out.line(
        wrapped === 0
          ? 'Every server was already wrapped.'
          : `${wrapped} server(s) wrapped. Restart your agent, then "memnox mcp unwrap" to undo.`,
      );
    });

  mcp
    .command('unwrap')
    .description('Put every MCP server back the way it was')
    .action(async () => {
      const configs = await readConfigs(home(), project());
      let restored = 0;

      for (const file of configs) {
        const { restore } = planUnwrap(file.servers);
        if (restore.length === 0) continue;

        context.out.line(file.path);
        for (const each of restore) {
          context.out.line(`  ${each.name}  proxy → ${each.after.command}`);
        }
        restored += restore.length;

        const next = { ...file.servers };
        const changed: Record<string, ServerLaunch> = {};
        for (const each of restore) {
          next[each.name] = each.after;
          changed[each.name] = each.after;
        }
        await writeConfig(home(), file, next, changed);
      }

      context.out.line('');
      context.out.line(
        restored === 0
          ? 'Nothing here was wrapped, so nothing was changed.'
          : `${restored} server(s) restored. Restart your agent.`,
      );
    });
}
