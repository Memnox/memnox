import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import {
  DECISION_EFFECT,
  digest,
  overlaysInForce,
  provenanceOf,
  SESSION_VAR,
  SqliteEventStore,
  type EventSink,
} from '@memnox/core';
import { ShellSeam, SHELL_EXIT_WITHHELD, type ShellDecision } from './shell-seam';
import { record } from './record';
import { DEFAULT_AGENT_NAME, ENV_AGENT_NAME } from './tool-hook.constants';
import {
  realShell,
  shellInvocation,
  SHELL_MODE,
  type ShellInvocation,
} from './shell-invocation';
import { buildAuthorizer, buildHold, buildLeases, log } from './seam-runtime';

const USAGE = `Usage: memnox-shell -c "<command line>"
       memnox-shell -- <command...>

Gates what was asked against policy, then runs it unchanged through the real shell.
A refusal names an alternative where the rule gave one, and nothing is ever rewritten.`;

const SHELL_NAME = 'memnox-shell';

/** What the gate rules on: the line as typed, whichever form it arrived in. */
function commandOf(invocation: ShellInvocation): string[] {
  if (invocation.mode === SHELL_MODE.COMMAND) return [invocation.line ?? ''];
  return invocation.argv ?? [];
}

/** Resolves to the exit code, so the row carries what happened rather than only what was decided. */
function run(executable: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { stdio: 'inherit' });
    child.on('exit', (code, signal) => {
      // A signalled child is not an exit code; 128+n is what a shell reports for one.
      resolve(code === null ? (signal === null ? SHELL_EXIT_WITHHELD : 128) : code);
    });
    child.on('error', (err: unknown) => {
      log(`could not run the command: ${String(err)}`);
      resolve(SHELL_EXIT_WITHHELD);
    });
  });
}

/** The ledger, or null when it will not open. A lost row never stops a command. */
function openLedger(home: string): EventSink | null {
  try {
    return SqliteEventStore.forHome(home);
  } catch {
    return null;
  }
}

/**
 * The row for what this seam decided.
 *
 * Every hold, refusal and approval reached here used to end with the process, so the
 * ledger had readers and no writer on the one surface an agent actually types into:
 * `why` said nothing had been decided seconds after a person refused something, and
 * `next` — the screen the whole product points at — counted no hand-overs because it
 * had never been shown one.
 */
async function keep(
  decision: ShellDecision,
  line: string,
  exitCode: number | undefined,
  startedAt: number,
): Promise<void> {
  const home = homedir();
  const sink = openLedger(home);
  if (sink === null) return;

  const overlays = await overlaysInForce(home);
  const provenance = await provenanceOf(home, overlays, new Date().toISOString());
  const [cli] = decision.action.split('.');

  await record(sink, {
    ...provenance,
    outcome: {
      allowed: decision.effect === DECISION_EFFECT.ALLOW,
      binary: cli ?? 'shell',
      args: [],
      action: decision.action,
      class: decision.class,
      argsDigest: digest(line),
      ...(decision.target === undefined ? {} : { target: decision.target }),
    },
    effect: decision.effect,
    reason: decision.reason,
    ...(decision.rule === undefined
      ? {}
      : { rule: { name: decision.rule, layer: 'project', file: 'policy' } }),
    at: new Date().toISOString(),
    agent: process.env[ENV_AGENT_NAME] ?? DEFAULT_AGENT_NAME,
    ...(exitCode === undefined ? {} : { exitCode }),
    durationMs: Date.now() - startedAt,
    ...(process.env[SESSION_VAR] === undefined
      ? {}
      : { sessionId: process.env[SESSION_VAR] }),
  });
}

async function main(): Promise<void> {
  const invocation = shellInvocation(process.argv.slice(2));
  const shell = realShell(process.env, SHELL_NAME);

  /* An interactive shell has nothing to rule on yet; every command typed into it is
     gated by the interceptors on PATH. Refusing here would only break the terminal. */
  if (invocation.mode === SHELL_MODE.INTERACTIVE) {
    if (process.stdin.isTTY !== true) {
      process.stderr.write(`${USAGE}\n`);
      process.exitCode = SHELL_EXIT_WITHHELD;
      return;
    }
    run(shell, invocation.flags);
    return;
  }

  const command = commandOf(invocation);
  if (command.length === 0 || command[0] === '') {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = SHELL_EXIT_WITHHELD;
    return;
  }

  const leases = buildLeases();
  const startedAt = Date.now();
  const seam = new ShellSeam({
    authorizer: await buildAuthorizer(),
    workingDirectory: process.cwd(),
    env: process.env,
    hold: buildHold(),
    agent: process.env[ENV_AGENT_NAME] ?? DEFAULT_AGENT_NAME,
    ...(process.env[SESSION_VAR] === undefined
      ? {}
      : { sessionId: process.env[SESSION_VAR] }),
    ...(leases === undefined ? {} : { leases }),
  });
  const outcome = await seam.gate(command);
  const line = command.join(' ');

  if (outcome.message !== undefined) log(outcome.message);
  if (outcome.run === undefined) {
    /* The refusal is written before the process ends, because a refused command has no
       exit code to wait for and this is the only moment the row can be taken. */
    await keep(outcome.decision, line, undefined, startedAt);
    process.exitCode = outcome.exitCode;
    return;
  }

  // Allowed: handed on exactly as it arrived, so what runs is what was written.
  const status =
    invocation.mode === SHELL_MODE.COMMAND
      ? await run(shell, [...invocation.flags, '-c', invocation.line ?? ''])
      : await runResolved(outcome.run);
  if (status === null) return;

  await keep(outcome.decision, line, status, startedAt);
  process.exitCode = status;
}

/** Null when there was nothing to run, which is not an outcome worth a row. */
async function runResolved(command: readonly string[]): Promise<number | null> {
  const [executable, ...args] = command;
  if (executable === undefined) return null;
  return run(executable, args);
}

main().catch((err: unknown) => {
  // A wrapper that throws must not read as a refusal; it ruled on nothing and says so.
  log(`shell seam failed, ruling on nothing: ${String(err)}`);
  process.exitCode = SHELL_EXIT_WITHHELD;
});
