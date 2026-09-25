/** `memnox run`: starts an agent with the interceptors, the shell wrapper, a session and a milestone in place. */

import { rm } from 'node:fs/promises';
import { delimiter } from 'node:path';
import type { Command } from 'commander';
import {
  CloudLeases,
  LeaseRegistry,
  SESSION_VAR,
  SessionContainments,
  LEDGER_SESSION_LIMIT,
  summarizeSession,
  describeSummary,
} from '@memnox/core';
import { FALLBACK_SHELL, interceptorDirFor, REAL_SHELL_VAR } from '@memnox/interceptors';
import type { CliContext } from '../cli-context';
import type { FlowRow } from '../flow';
import { sessionGuardPath } from '../memnox-paths';
import { describeCount } from '../plural';
import { withEvents } from '../event-store';
import { binaryMeantBy, onPath } from '../on-path';
import {
  nowOf,
  prepareRun,
  type PreparedRun,
  type RunDeps,
  type RunOptions,
} from './run/prepare';
import { SESSION_GUARD_EXTENSIONS } from './run/sandbox';
import { defaultStart, interceptorsIn, wiringRow } from './run/start';

/**
 * Everything the child needs to be governed, set as environment rather than asked of the
 * agent: interceptors first on PATH, SHELL pointing at the wrapper, and a session id.
 */
export function environmentFor(
  base: NodeJS.ProcessEnv,
  home: string,
  sessionId: string,
  shellBinary: string,
): NodeJS.ProcessEnv {
  const interceptors = interceptorDirFor(home);
  const path = base['PATH'] ?? '';
  return {
    ...base,
    PATH: path.startsWith(interceptors) ? path : `${interceptors}${delimiter}${path}`,
    SHELL: shellBinary,
    // The displaced shell, so the wrapper hands off to it and never reads `SHELL` to find itself.
    [REAL_SHELL_VAR]: base['SHELL'] ?? FALLBACK_SHELL,
    [SESSION_VAR]: sessionId,
  };
}

export function registerRunCommand(
  program: Command,
  context: CliContext,
  deps: RunDeps = {},
): void {
  program
    .command('run')
    .description('Start an agent with the interceptors, the proxy and a session in place')
    .argument('<command...>', 'the agent command, after --')
    .option('--shell <path>', 'shell the agent should use', 'memnox-shell')
    .option(
      '--transcript',
      'keep a local copy of what the agent printed, so a claim can be checked against the record',
    )
    .option('--no-guard', 'start outside the kernel sandbox even when a profile exists')
    .option('--no-milestone', 'do not keep the working tree before the agent starts')
    .option(
      '--untrusted',
      'a repository nobody here vouched for: writes stay in it, secrets unreadable, the network asks',
    )
    .option('--task <statement>', 'what you actually asked for, in your words')
    .option('--paths <globs>', 'paths the task covers, comma separated')
    .option('--repos <list>', 'repositories the task covers, comma separated')
    .option('--services <list>', 'services the task covers, comma separated')
    .option('--envs <list>', 'environments the task covers, comma separated')
    .option('--expect <count>', 'roughly how many actions this should take')
    .option('--role <name>', 'the job this agent is enrolled under, matched by roles:')
    .action(async (command: readonly string[], options: RunOptions) =>
      runAgent(context, deps, command, options),
    );
}

/**
 * Starts the agent with every seam in front of it. The rail is commentary here, because
 * what stdout carries once the agent starts is the agent's own output, teed through.
 */
async function runAgent(
  context: CliContext,
  deps: RunDeps,
  command: readonly string[],
  options: RunOptions,
): Promise<void> {
  context.flow.commentary();
  context.flow.open('memnox run');
  const binary = resolveBinary(command, deps);
  const run = await prepareRun({
    binary,
    command,
    options,
    deps,
    environment: (home, sessionId) =>
      environmentFor(deps.env ?? process.env, home, sessionId, options.shell),
  });
  renderStart(context, run, deps);
  await startAndRelease(context, run, deps);
}

/** Refused before a session, a milestone or the sandbox, so nothing is kept for a run that never starts. */
function resolveBinary(command: readonly string[], deps: RunDeps): string {
  const binary = command[0];
  if (binary === undefined) {
    throw new Error('Name the command to run:  memnox run -- claude');
  }
  if ((deps.onPath ?? onPath)(binary)) return binary;
  const meant = (deps.binaryMeantBy ?? binaryMeantBy)(binary);
  const hint =
    meant === null
      ? ''
      : `\nThe binary for ${binary} is "${meant}":  memnox run -- ${meant}`;
  throw new Error(`"${binary}" is not on PATH, so there is nothing to start.${hint}`);
}

function renderStart(context: CliContext, run: PreparedRun, deps: RunDeps): void {
  const rows: FlowRow[] = [
    { label: 'session', value: run.sessionId },
    wiringRow(context, run.home, deps.interceptorsIn ?? interceptorsIn),
    ...containmentRows(context, run),
  ];
  if (run.declared !== null) {
    rows.push({ label: 'task', value: `"${run.declared.statement}"` });
    if (run.declared.expectedActions !== undefined) {
      rows.push({
        label: 'expecting',
        value: `about ${run.declared.expectedActions} actions`,
      });
    }
  }
  if (run.kept !== null) {
    rows.push({
      label: 'working tree',
      value: `kept as ${run.kept}, and "memnox rewind" undoes it`,
    });
  }
  if (run.transcript !== undefined)
    rows.push({ label: 'transcript', value: run.transcript });
  context.flow.rows(`Starting ${run.binary}`, rows);
  context.flow.close(`${run.binary} is running under session ${run.sessionId}.`);
  if (run.hint !== null) context.flow.hint(run.hint);
}

/** The wall and the network, said as they are, including where there is neither. */
function containmentRows(context: CliContext, run: PreparedRun): FlowRow[] {
  const { style } = context;
  const sandbox = run.sandbox;
  const rows: FlowRow[] = [
    {
      label: 'sandbox',
      value:
        sandbox.guard === null ? sandbox.because : `${sandbox.guard}: ${sandbox.because}`,
    },
    {
      label: 'network',
      value:
        run.egress === null
          ? style.warn('not proxied, since no egress proxy would start')
          : `through the ${run.egress.source} egress proxy on port ${run.egress.port}, ruled on by host`,
    },
  ];
  if (run.untrusted) {
    rows.push({
      label: 'untrusted',
      value:
        'writes stay in the repository and temp; outward and destructive actions ask',
    });
  }
  return rows;
}

async function startAndRelease(
  context: CliContext,
  run: PreparedRun,
  deps: RunDeps,
): Promise<void> {
  const start = deps.start ?? defaultStart;
  const [executable, ...args] = run.sandbox.command;
  try {
    process.exitCode = await start(
      executable ?? run.binary,
      args,
      run.env,
      run.transcript,
    );
  } finally {
    // In a `finally`, because an agent that crashed is the one whose paths must not stay held.
    const released = await releaseLeases(run.home, run.sessionId, deps);
    await endContainment(run);
    // Off the rail, because it closed when the agent took over the terminal.
    const said = [
      released > 0 ? `released ${describeCount(released, 'lease')}` : null,
      await summaryOf(run),
    ].filter((line): line is string => line !== null);
    if (said.length > 0) context.out.note(said.join('\n'));
  }
}

/** What the session did, in one line, so nobody has to ask for it. Null when nothing was kept. */
async function summaryOf(run: PreparedRun): Promise<string | null> {
  try {
    const events = await withEvents(run.home, (store) =>
      store.query({ sessionId: run.sessionId, limit: LEDGER_SESSION_LIMIT }),
    );
    const summary = summarizeSession(events);
    return summary === null ? null : describeSummary(summary);
  } catch {
    // A ledger that will not open is no reason to make an agent's exit fail.
    return null;
  }
}

/** Quiet on failure: a register that cannot be written must not stop an agent exiting. */
async function releaseLeases(
  home: string,
  sessionId: string,
  deps: RunDeps,
): Promise<number> {
  try {
    const registry = new LeaseRegistry(home);
    const released = await registry.releaseSession(sessionId, nowOf(deps).toISOString());
    // Once per agent in the workspace too, or another machine waits on paths nobody writes.
    const shared = new CloudLeases(home);
    const agents = new Set(released.map((lease) => lease.holder.agent));
    for (const agent of agents) {
      await shared.releaseSession({ agent, sessionId, pid: process.pid });
    }
    return released.length;
  } catch {
    return 0;
  }
}

/** The session's proxy closed and its record gone, so nothing outlives the agent it was for. */
async function endContainment(run: PreparedRun): Promise<void> {
  await run.egress?.close().catch(() => undefined);
  await new SessionContainments(run.home).clear(run.sessionId).catch(() => undefined);
  for (const extension of SESSION_GUARD_EXTENSIONS) {
    await rm(sessionGuardPath(run.home, run.sessionId, extension), { force: true }).catch(
      () => undefined,
    );
  }
}
