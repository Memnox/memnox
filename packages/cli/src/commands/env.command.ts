/**
 * `memnox env`: the environment a service manager has to set for itself, because systemd,
 * a container or cron read no shell profile. Printed, never written into a unit file.
 */

import { delimiter } from 'node:path';
import { homedir } from 'node:os';
import type { Command } from 'commander';
import { SESSION_VAR } from '@memnox/core';
import { interceptorDirFor, REAL_SHELL_VAR } from '@memnox/interceptors';
import type { CliContext } from '../cli-context';

const FORMATS = ['sh', 'systemd', 'docker'] as const;
type Format = (typeof FORMATS)[number];

/** What each falls back to when this shell has none set. */
const FALLBACK = {
  SHELL: '/bin/sh',
  PATH: '/usr/local/bin:/usr/bin:/bin',
} as const;

/** What `env` reads the machine through, injected so a test never reads the real one. */
interface EnvDeps {
  home: () => string;
  env: NodeJS.ProcessEnv;
}

interface EnvOptions {
  format: string;
  shell: string;
  session?: string;
}

type Pairs = readonly [string, string][];

export function registerEnvCommand(
  program: Command,
  context: CliContext,
  overrides: Partial<EnvDeps> = {},
): void {
  const deps: EnvDeps = { home: homedir, env: process.env, ...overrides };
  program
    .command('env')
    .description('The environment an agent needs when something else starts it')
    .option('--format <format>', `one of: ${FORMATS.join(', ')}`, 'sh')
    .option('--shell <path>', 'shell the agent should use', 'memnox-shell')
    .option('--session <id>', 'group this run in the timeline under one session')
    .action(async (options: EnvOptions) => runEnv(context, deps, options));
}

function isFormat(value: string): value is Format {
  return FORMATS.some((format) => format === value);
}

/** The environment a service manager has to set for itself, printed rather than written. */
async function runEnv(
  context: CliContext,
  deps: EnvDeps,
  options: EnvOptions,
): Promise<void> {
  const { format } = options;
  if (!isFormat(format)) {
    throw new Error(`--format takes one of: ${FORMATS.join(', ')}`);
  }
  // The lines go to stdout to be pasted or sourced, so the rail moves to stderr.
  context.flow.commentary();
  context.flow.open('memnox env');

  const pairs: [string, string][] = [
    ['PATH', `${interceptorDirFor(deps.home())}${delimiter}$PATH`],
    ['SHELL', options.shell],
    [REAL_SHELL_VAR, deps.env['SHELL'] ?? FALLBACK.SHELL],
  ];
  if (options.session !== undefined) pairs.push([SESSION_VAR, options.session]);

  if (format === 'systemd') return renderSystemd(context, pairs, deps.env);
  if (format === 'docker') return renderDocker(context, pairs, deps.env);
  return renderShell(context, pairs);
}

/** PATH is expanded by hand: systemd runs no shell, so `$PATH` would be four literal characters. */
function renderSystemd(context: CliContext, pairs: Pairs, env: NodeJS.ProcessEnv): void {
  const { out, flow } = context;
  flow.step('For a systemd unit', `${pairs.length} variables, below`);
  for (const [key, value] of pairs) {
    out.line(`Environment="${key}=${expand(key, value, env)}"`);
  }
  flow.close('Put these in the [Service] section.');
  flow.hint('Then: systemctl daemon-reload');
  flow.hint('The interceptors must be readable by the user the unit runs as.');
  // The expansion is this shell's PATH, so it has to be generated where the agent runs.
  flow.hint(
    "Run this on the machine and as the user the agent runs as; PATH is this shell's.",
  );
}

function renderDocker(context: CliContext, pairs: Pairs, env: NodeJS.ProcessEnv): void {
  const { out, flow } = context;
  flow.step('For a Dockerfile', `${pairs.length} variables, below`);
  for (const [key, value] of pairs) out.line(`ENV ${key}=${expand(key, value, env)}`);
  // The directory lives in the home the interceptors were installed into.
  flow.close('Add these to the image.');
  flow.hint('It also needs ~/.memnox: mount it, or install inside the image.');
  flow.hint("PATH here is this shell's; check it names binaries the image actually has.");
}

function renderShell(context: CliContext, pairs: Pairs): void {
  const { out, flow } = context;
  flow.step('For a shell', `${pairs.length} variables, below`);
  for (const [key, value] of pairs) out.line(`export ${key}="${value}"`);
  flow.close('Source this before starting the agent.');
  flow.hint('Or use "memnox run", which sets all of it for one command.');
}

/** `$PATH` means nothing outside a shell, so it is resolved before it is printed. */
function expand(key: string, value: string, env: NodeJS.ProcessEnv): string {
  if (key !== 'PATH') return value;
  return value.replace('$PATH', env['PATH'] ?? FALLBACK.PATH);
}
