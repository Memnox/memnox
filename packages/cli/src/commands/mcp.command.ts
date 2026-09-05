import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import {
  MEMNOX_HOME,
  PROXY_BINARY,
  planUnwrap,
  planWrap,
  serversKeyOf,
  type ServerLaunch,
} from '@memnox/core';
import type { CliContext } from '../cli-context';

/** The configs a wrap touches. Each is optional; a machine has some subset. */
const CONFIG_PATHS: readonly string[] = [
  '.claude.json',
  '.cursor/mcp.json',
  '.cline/settings.json',
  '.vscode/mcp.json',
  'Library/Application Support/Claude/claude_desktop_config.json',
  '.config/Claude/claude_desktop_config.json',
];

interface ConfigFile {
  path: string;
  raw: string;
  config: Record<string, unknown>;
  key: string;
  servers: Record<string, ServerLaunch>;
}

function backupPathFor(home: string, path: string): string {
  return join(home, MEMNOX_HOME, 'backup', path.replace(/[/\\ ]/g, '_'));
}

async function readConfigs(home: string): Promise<ConfigFile[]> {
  const found: ConfigFile[] = [];
  for (const relative of CONFIG_PATHS) {
    const path = join(home, relative);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      // A config this machine does not have is the ordinary case, not a failure.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
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
      config,
      key,
      servers: config[key] as Record<string, ServerLaunch>,
    });
  }
  return found;
}

/** Backup first, always. The failure that matters is an editor that will not start. */
async function writeConfig(
  home: string,
  file: ConfigFile,
  servers: Record<string, ServerLaunch>,
): Promise<void> {
  const backup = backupPathFor(home, file.path);
  await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
  await copyFile(file.path, backup);
  const next = { ...file.config, [file.key]: servers };
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
      const configs = await readConfigs(home());
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
        wrapped += plan.wrap.length;

        if (options.dryRun === true) continue;
        const next = { ...file.servers };
        for (const each of plan.wrap) next[each.name] = each.after;
        await writeConfig(home(), file, next);
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
      const configs = await readConfigs(home());
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
        for (const each of restore) next[each.name] = each.after;
        await writeConfig(home(), file, next);
      }

      context.out.line('');
      context.out.line(
        restored === 0
          ? 'Nothing here was wrapped, so nothing was changed.'
          : `${restored} server(s) restored. Restart your agent.`,
      );
    });
}
