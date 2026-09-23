import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';

import {
  agentBehind,
  CloudActions,
  DECISION_EFFECT,
  ENV_AGENT_NAME,
  EXIT,
  holderPid,
  isBrowserLauncher,
  openLedger,
  overlaysInForce,
  protectionStopped,
  provenanceOf,
  SESSION_VAR,
  splitCommandLine,
  urlArgumentIn,
  type EventSink,
  type LocalGate,
  type Overlay,
} from '@memnox/core';

import { observeSession, pauseHolding, pauseMessage } from './breaker-seam';
import { BrowserSeam } from './browser-seam';
import { checkpointBeforeCommand } from './checkpoint-seam';
import { reportToDaemon } from './daemon-client';
import { readHookConfig } from './hook-config';
import { loadHookGate } from './hook-gate-loader';
import {
  INTERCEPT_BINARY,
  invokedFor,
  realPath,
  resolveReal,
  ruleOnCommand,
  type InterceptOutcome,
} from './interceptor';
import { record, type Provenance } from './record';
import { buildHold, log, pidSessionId } from './seam-runtime';
import { ancestorsOf } from './process-ancestry';
import { claimShellAction, shellAction, type ShellClaim } from './shell-action';
import { DEFAULT_AGENT_NAME } from './tool-hook.constants';

/**
 * One binary behind every interceptor: it reads which name it was called as, rules on the
 * arguments, and only then hands over to the real binary with our directory off PATH.
 */

/** Signals the terminal sends the whole group, which the command answers for itself. */
const FORWARDED: readonly NodeJS.Signals[] = ['SIGINT', 'SIGQUIT'];

/**
 * What one intercepted command is ruled on and recorded with, read once when it arrives.
 */
interface RunContext {
  home: string;
  gate: LocalGate | null;
  overlays: readonly Overlay[];
  /**
   * Read at arrival, so a verdict replays against the bundle and freeze in force then.
   */
  provenance: Provenance;
  sink: EventSink | null;
  sessionId: string | undefined;
  started: number;
}

/** One command line, as it will be run. */
interface Command {
  binary: string;
  args: readonly string[];
}

async function main(): Promise<void> {
  const invocation = invokedFor(process.argv);
  if (invocation === null) {
    process.stderr.write(
      'memnox-intercept is run through the wrappers in ~/.memnox/bin, not directly.\n' +
        'Usage: memnox-intercept <binary> [args...]\n',
    );
    process.exit(EXIT.MISUSED);
  }
  const home = homedir();
  // A person typing git in their own terminal is not an agent, and `memnox stop` rules on
  // nobody, so in either case nothing stands between the command and the real binary.
  const person = agentBehind(process.env, ancestorsOf(process.ppid)) === null;
  if (person || (await protectionStopped(home))) {
    process.exit(await hand(invocation, home));
  }
  const sessionId = process.env[SESSION_VAR];

  // A held session runs nothing, and is checked first so a paused agent asks nobody.
  const held = await pauseHolding(home, sessionId);
  if (held !== null) {
    process.stderr.write(`${pauseMessage(held)}\n`);
    process.exit(EXIT.FAILED);
  }

  const context = await readRunContext(home, sessionId);
  const outcome = await ruleOn(invocation, context);
  if (!outcome.allowed) return refuse(outcome, context);
  await ruleOnBrowser(invocation, context);
  await handAndRecord(invocation, outcome, context);
}

async function readRunContext(
  home: string,
  sessionId: string | undefined,
): Promise<RunContext> {
  const gate = await loadHookGate(await readHookConfig(process.env, home));
  const overlays = await overlaysInForce(home);
  const provenance = await provenanceOf(home, overlays, new Date().toISOString());
  return {
    home,
    gate,
    overlays,
    provenance,
    sink: openLedger(home),
    sessionId,
    started: Date.now(),
  };
}

function ruleOn(command: Command, context: RunContext): Promise<InterceptOutcome> {
  return ruleOnCommand(command.binary, command.args, {
    ...(context.gate === null ? {} : { gate: context.gate }),
    overlays: context.overlays,
    env: process.env,
    // Without a hold an `ask` rule denies instead of asking.
    hold: buildHold(),
    ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
  });
}

/**
 * A refusal is printed and recorded, unless a person typed a replacement the rules allow.
 */
async function refuse(outcome: InterceptOutcome, context: RunContext): Promise<never> {
  process.stderr.write(`${outcome.message ?? 'denied'}\n`);
  if (outcome.edited !== undefined) await ruleOnEdited(outcome.edited, context);
  await record(context.sink, {
    ...context.provenance,
    outcome,
    effect: DECISION_EFFECT.DENY,
    reason: outcome.reason ?? 'denied',
    ...(outcome.rule === undefined ? {} : { rule: outcome.rule }),
    at: new Date().toISOString(),
    ...sessionField(context),
  });
  process.exit(EXIT.FAILED);
}

/**
 * An edited command is a new command, ruled on from
 * the start, or "[e]" is the way around every rule.
 */
async function ruleOnEdited(edited: string, context: RunContext): Promise<void> {
  const [next, ...rest] = splitCommandLine(edited);
  if (next === undefined || basename(next) === INTERCEPT_BINARY) return;
  process.stderr.write(`memnox: ruling on the replacement\n`);
  const replacement = { binary: basename(next), args: rest };
  const again = await ruleOn(replacement, context);
  if (again.allowed) return handAndRecord(replacement, again, context);
  process.stderr.write(`${again.message ?? 'denied'}\n`);
}

/**
 * A launcher is ruled on again by where it is going,
 * since it carries the person's signed-in session.
 */
async function ruleOnBrowser(command: Command, context: RunContext): Promise<void> {
  if (!isBrowserLauncher(command.binary)) return;
  const url = urlArgumentIn(command.args);
  if (url === null) return;
  const seam = new BrowserSeam({
    ...(context.gate === null ? {} : { gate: context.gate }),
    ...sessionField(context),
  });
  const visit = await seam.navigate(url);
  if (visit.allowed) return;
  process.stderr.write(`${visit.message ?? 'denied'}\n`);
  process.exit(EXIT.FAILED);
}

function sessionField(context: RunContext): { sessionId?: string } {
  return context.sessionId === undefined ? {} : { sessionId: context.sessionId };
}

/**
 * Runs it, records what happened, and only then
 * exits, so the exit code and duration reach the row.
 */
async function handAndRecord(
  command: Command,
  outcome: InterceptOutcome,
  context: RunContext,
): Promise<never> {
  // Asked only of what the rules allowed, at the moment it would run.
  const claim = await anotherAgentHasIt(command, outcome, context);
  if ('refused' in claim) return refuseAsClaimed(claim.refused, outcome, context);

  await keepBeforeDestroying(command, context);
  // Held while the command runs, so another machine
  // waits on work being done rather than a window.
  const status = await hand(command, context.home);
  await claim.release();
  // The breaker watches outcomes; no daemon means no counters, never a held command.
  await reportToDaemon(context.home, {
    action: outcome.action,
    exitCode: status,
    ...(outcome.target === undefined ? {} : { target: outcome.target }),
    ...sessionField(context),
  });
  await recordAllowed(outcome, status, context);

  // Reported now and enforced on the next command, because this one has already run.
  const tripped = await observeSession({
    home: context.home,
    sessionId: context.sessionId,
  });
  if (tripped !== null) process.stderr.write(`${pauseMessage(tripped)}\n`);
  process.exit(status);
}

/** The tree before `rm -r` or `git reset --hard` runs, so `memnox rewind` can undo it. */
async function keepBeforeDestroying(
  command: Command,
  context: RunContext,
): Promise<void> {
  await checkpointBeforeCommand(
    {
      home: context.home,
      sessionId: context.sessionId ?? pidSessionId(holderPid(process.ppid, process.pid)),
      agent: process.env[ENV_AGENT_NAME] ?? DEFAULT_AGENT_NAME,
      place: process.cwd(),
      now: () => new Date(),
      log,
    },
    [command.binary, ...command.args],
  );
}

async function refuseAsClaimed(
  refused: string,
  outcome: InterceptOutcome,
  context: RunContext,
): Promise<never> {
  process.stderr.write(`memnox: ${refused}\n`);
  await record(context.sink, {
    ...context.provenance,
    outcome: { ...outcome, allowed: false },
    effect: DECISION_EFFECT.DENY,
    reason: refused,
    at: new Date().toISOString(),
    ...sessionField(context),
  });
  process.exit(EXIT.FAILED);
}

async function recordAllowed(
  outcome: InterceptOutcome,
  status: number,
  context: RunContext,
): Promise<void> {
  await record(context.sink, {
    ...context.provenance,
    outcome,
    effect: DECISION_EFFECT.ALLOW,
    reason: outcome.reason ?? 'no rule matched',
    ...(outcome.rule === undefined ? {} : { rule: outcome.rule }),
    at: new Date().toISOString(),
    exitCode: status,
    durationMs: Date.now() - context.started,
    ...sessionField(context),
  });
}

/**
 * Refused with who has it, or free to run and holding the claim while it does. The same
 * register the MCP proxy asks, so `gh pr close 12` and `close_pull_request` meet.
 */
async function anotherAgentHasIt(
  command: Command,
  outcome: InterceptOutcome,
  context: RunContext,
): Promise<ShellClaim> {
  const action = shellAction(command.binary, command.args, outcome);
  if (action === null) return { release: async () => undefined };
  const owner = holderPid(process.ppid, process.pid);
  return claimShellAction(action, new CloudActions(context.home), {
    agent: process.env[ENV_AGENT_NAME] ?? DEFAULT_AGENT_NAME,
    sessionId: context.sessionId ?? pidSessionId(owner),
    pid: owner,
  });
}

/**
 * Stdio untouched and the exit code passed straight
 * back, so the agent sees what it would without us.
 */
function hand(command: Command, home: string): Promise<number> {
  const path = realPath(process.env['PATH'] ?? '', home);
  const real = resolveReal(command.binary, path, existsSync);
  if (real === null) {
    process.stderr.write(
      `memnox: ${command.binary} is not on PATH behind the interceptor\n`,
    );
    process.exit(EXIT.NOT_FOUND);
  }
  // Not blocking, so the claim can be renewed while
  // it runs; an interrupt reaches the command itself.
  const ignore = (): void => undefined;
  for (const signal of FORWARDED) process.on(signal, ignore);
  return new Promise((resolve) => {
    const child = spawn(real, [...command.args], {
      stdio: 'inherit',
      env: { ...process.env, PATH: path },
    });
    child.on('error', () => resolve(EXIT.FAILED));
    child.on('exit', (code) => {
      for (const each of FORWARDED) process.off(each, ignore);
      // A signalled child has no code, which a blocking spawn reported as 1 too.
      resolve(code ?? EXIT.FAILED);
    });
  });
}

void main();
