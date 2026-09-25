import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

import {
  DECISION_EFFECT,
  digest,
  ENV_AGENT_NAME,
  exitCodeForSignal,
  holderPid,
  localRuleRef,
  openLedger,
  overlaysInForce,
  provenanceOf,
  SESSION_VAR,
  SIGNAL_NUMBER,
} from '@memnox/core';

import { checkpointBeforeLine } from './checkpoint-seam';
import { record } from './record';
import {
  buildAuthorizer,
  buildHold,
  buildLeases,
  log,
  pidSessionId,
} from './seam-runtime';
import {
  parseShellInvocation,
  realShell,
  SHELL_MODE,
  type ShellInvocation,
} from './shell-invocation';
import {
  ShellSeam,
  SHELL_EXIT_OK,
  SHELL_EXIT_WITHHELD,
  type ShellDecision,
} from './shell-seam';
import { DEFAULT_AGENT_NAME } from './tool-hook.constants';

/**
 * The shell wrapper as a process, which `memnox run` sets as
 * `SHELL`: it rules on the line, runs the real shell, and
 * records what happened, exiting `EXIT.WITHHELD` on a refusal.
 */

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

function isNumberedSignal(signal: NodeJS.Signals): signal is keyof typeof SIGNAL_NUMBER {
  return signal in SIGNAL_NUMBER;
}

/**
 * A signal is `128 + n`, as a shell reports one;
 * no code and no signal means it never ran.
 */
function signalledExit(signal: NodeJS.Signals | null): number {
  if (signal === null || !isNumberedSignal(signal)) return SHELL_EXIT_WITHHELD;
  return exitCodeForSignal(signal);
}

/**
 * Resolves to the exit code, so the row carries
 * what happened rather than only what was decided.
 */
function run(executable: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { stdio: 'inherit' });
    child.on('exit', (code, signal) => {
      resolve(code === null ? signalledExit(signal) : code);
    });
    child.on('error', (err: unknown) => {
      log(`could not run the command: ${String(err)}`);
      resolve(SHELL_EXIT_WITHHELD);
    });
  });
}

/** One line the seam ruled on, and how it went. */
interface ShellRun {
  decision: ShellDecision;
  line: string;
  exitCode: number | undefined;
  startedAt: number;
}

/**
 * The row for what this seam decided, so `why`,
 * `timeline` and `next` have something to read.
 */
async function keep(ran: ShellRun): Promise<void> {
  const home = homedir();
  const sink = openLedger(home);
  if (sink === null) return;

  const { decision } = ran;
  const overlays = await overlaysInForce(home);
  const provenance = await provenanceOf(home, overlays, new Date().toISOString());
  const [cli] = decision.action.split('.');
  const sessionId = process.env[SESSION_VAR];
  await record(sink, {
    ...provenance,
    outcome: {
      allowed: decision.effect === DECISION_EFFECT.ALLOW,
      binary: cli ?? 'shell',
      args: [],
      action: decision.action,
      class: decision.class,
      argsDigest: digest(ran.line),
      ...(decision.target === undefined ? {} : { target: decision.target }),
    },
    effect: decision.effect,
    reason: decision.reason,
    ...(decision.rule === undefined ? {} : { rule: localRuleRef(decision.rule) }),
    at: new Date().toISOString(),
    agent: process.env[ENV_AGENT_NAME] ?? DEFAULT_AGENT_NAME,
    ...(ran.exitCode === undefined ? {} : { exitCode: ran.exitCode }),
    durationMs: Date.now() - ran.startedAt,
    ...(sessionId === undefined ? {} : { sessionId }),
  });
}

async function main(): Promise<void> {
  const invocation = parseShellInvocation(process.argv.slice(2));
  const shell = realShell(process.env, SHELL_NAME);

  // An interactive shell has nothing to rule on yet, since
  // every command typed into it meets the interceptors.
  if (invocation.mode === SHELL_MODE.INTERACTIVE && process.stdin.isTTY === true) {
    process.exitCode = await run(shell, invocation.flags);
    return;
  }
  const command = commandOf(invocation);
  if (
    invocation.mode === SHELL_MODE.INTERACTIVE ||
    command.length === 0 ||
    command[0] === ''
  ) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = SHELL_EXIT_WITHHELD;
    return;
  }
  process.exitCode = await gateAndRun(invocation, command, shell);
}

/**
 * Rules on the line, runs it where allowed exactly
 * as it arrived, and answers with the exit code.
 */
async function gateAndRun(
  invocation: ShellInvocation,
  command: readonly string[],
  shell: string,
): Promise<number> {
  const startedAt = Date.now();
  const seam = await buildSeam();
  const outcome = await seam.gate(command);
  const line = command.join(' ');
  if (outcome.message !== undefined) log(outcome.message);
  if (outcome.run === undefined) {
    // A refused command has no exit code to wait
    // for, so this is the only moment for its row.
    await keep({ decision: outcome.decision, line, exitCode: undefined, startedAt });
    return outcome.exitCode;
  }

  await keepBeforeDestroying(line);
  const status =
    invocation.mode === SHELL_MODE.COMMAND
      ? await run(shell, [...invocation.flags, '-c', invocation.line ?? ''])
      : await runResolved(outcome.run);
  if (status === null) return SHELL_EXIT_OK;
  await keep({ decision: outcome.decision, line, exitCode: status, startedAt });
  return status;
}

/** The tree before a line that deletes or discards work, so `memnox rewind` can undo it. */
async function keepBeforeDestroying(line: string): Promise<void> {
  await checkpointBeforeLine(
    {
      home: homedir(),
      sessionId:
        process.env[SESSION_VAR] ?? pidSessionId(holderPid(process.ppid, process.pid)),
      agent: process.env[ENV_AGENT_NAME] ?? DEFAULT_AGENT_NAME,
      place: process.cwd(),
      now: () => new Date(),
      log,
    },
    line,
  );
}

async function buildSeam(): Promise<ShellSeam> {
  const leases = buildLeases();
  const sessionId = process.env[SESSION_VAR];
  return new ShellSeam({
    authorizer: await buildAuthorizer(),
    workingDirectory: process.cwd(),
    env: process.env,
    home: homedir(),
    hold: buildHold(),
    agent: process.env[ENV_AGENT_NAME] ?? DEFAULT_AGENT_NAME,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(leases === undefined ? {} : { leases }),
  });
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
