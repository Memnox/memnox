import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { observeSession, pauseHolding, pauseMessage } from './breaker-seam';
import {
  DECISION_EFFECT,
  isBrowserLauncher,
  overlaysInForce,
  provenanceOf,
  SESSION_VAR,
  splitCommandLine,
  SqliteEventStore,
  urlArgumentIn,
  type EventSink,
} from '@memnox/core';
import {
  INTERCEPT_BINARY,
  invokedFor,
  realPath,
  resolveReal,
  ruleOnCommand,
} from './interceptor';
import { BrowserSeam } from './browser-seam';
import { loadHookGate } from './hook-gate-loader';
import { readHookConfig } from './hook-config';
import { record } from './record';
import { reportToDaemon } from './daemon-client';
import { buildHold, log } from './seam-runtime';

/**
 * One binary behind every interceptor. It is invoked through a name in the interceptor directory,
 * reads which name it was called as, rules on the arguments, and only then hands over
 * to the real binary with our directory taken off PATH.
 */
async function main(): Promise<void> {
  const invocation = invokedFor(process.argv);
  if (invocation === null) {
    process.stderr.write(
      'memnox-intercept is run through the wrappers in ~/.memnox/bin, not directly.\n' +
        'Usage: memnox-intercept <binary> [args...]\n',
    );
    process.exit(2);
  }
  const { binary, args } = invocation;
  const home = homedir();

  const config = await readHookConfig(process.env, home);
  const gate = await loadHookGate(config);

  const overlays = await overlaysInForce(home);
  /* Read once, at the moment the command arrives: a verdict has to be replayable
     against the bundle and the freeze that were in force when it was reached, not
     against whichever ones happen to be there when somebody asks. */
  const provenance = await provenanceOf(home, overlays, new Date().toISOString());
  const sink = openLedger(home);
  const started = Date.now();
  const outcome = await ruleOnCommand(binary, args, {
    ...(gate === null ? {} : { gate }),
    overlays,
    env: process.env,
    /* Without this an `ask` rule denies instead of asking, which is the difference
       between an agent that can be left running and one that cannot. */
    hold: buildHold(),
    ...(process.env[SESSION_VAR] === undefined
      ? {}
      : { sessionId: process.env[SESSION_VAR] }),
    log,
  });

  /* A held session runs nothing. Checked before the rules rather than after, because
     the point of a pause is that the agent stops, not that it keeps asking. */
  const held = await pauseHolding(home, process.env[SESSION_VAR]);
  if (held !== null) {
    process.stderr.write(`${pauseMessage(held)}\n`);
    process.exit(1);
  }

  if (!outcome.allowed) {
    process.stderr.write(`${outcome.message ?? 'denied'}\n`);
    /* An edited command is a new command: it goes through the rules from the start.
       Running it because a person typed it would make "[e]" the way around all of them. */
    if (outcome.edited !== undefined) {
      const replacement = splitCommandLine(outcome.edited);
      const [next, ...rest] = replacement;
      if (next !== undefined && basename(next) !== INTERCEPT_BINARY) {
        process.stderr.write(`memnox: ruling on the replacement\n`);
        const again = await ruleOnCommand(basename(next), rest, {
          ...(gate === null ? {} : { gate }),
          overlays,
          env: process.env,
          hold: buildHold(),
          log,
        });
        if (again.allowed) {
          await handAndRecord(
            basename(next),
            rest,
            home,
            sink,
            again,
            started,
            provenance,
          );
          return;
        }
        process.stderr.write(`${again.message ?? 'denied'}\n`);
      }
    }
    await record(sink, {
      ...provenance,
      outcome,
      effect: DECISION_EFFECT.DENY,
      reason: outcome.reason ?? 'denied',
      ...(outcome.rule === undefined ? {} : { rule: outcome.rule }),
      at: new Date().toISOString(),
      ...(process.env[SESSION_VAR] === undefined
        ? {}
        : { sessionId: process.env[SESSION_VAR] }),
    });
    process.exit(1);
  }

  /* A launcher is ruled on again by where it is going. The host is the thing worth
     asking about: the driver arrives carrying the person's own signed-in session. */
  if (isBrowserLauncher(binary)) {
    const url = urlArgumentIn(args);
    if (url !== null) {
      const seam = new BrowserSeam({
        ...(gate === null ? {} : { gate }),
        ...(process.env[SESSION_VAR] === undefined
          ? {}
          : { sessionId: process.env[SESSION_VAR] }),
      });
      const visit = await seam.navigate(url);
      if (!visit.allowed) {
        process.stderr.write(`${visit.message ?? 'denied'}\n`);
        process.exit(1);
      }
    }
  }

  await handAndRecord(binary, args, home, sink, outcome, started, provenance);
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
 * Runs it, records what happened, and only then exits — so the exit code and the
 * duration reach the row rather than being lost with the process.
 */
async function handAndRecord(
  binary: string,
  args: readonly string[],
  home: string,
  sink: EventSink | null,
  outcome: Awaited<ReturnType<typeof ruleOnCommand>>,
  started: number,
  provenance: Awaited<ReturnType<typeof provenanceOf>>,
): Promise<never> {
  const status = hand(binary, args, home);
  /* The breaker watches outcomes, and this is the only place one exists. Best effort:
     no daemon means the counters are not kept, never that the command is held up. */
  await reportToDaemon(home, {
    action: outcome.action,
    exitCode: status,
    ...(outcome.target === undefined ? {} : { target: outcome.target }),
    ...(process.env[SESSION_VAR] === undefined
      ? {}
      : { sessionId: process.env[SESSION_VAR] }),
  });
  await record(sink, {
    ...provenance,
    outcome,
    effect: DECISION_EFFECT.ALLOW,
    reason: outcome.reason ?? 'no rule matched',
    ...(outcome.rule === undefined ? {} : { rule: outcome.rule }),
    at: new Date().toISOString(),
    exitCode: status,
    durationMs: Date.now() - started,
    ...(process.env[SESSION_VAR] === undefined
      ? {}
      : { sessionId: process.env[SESSION_VAR] }),
  });

  /* The row is written, so the session can be replayed. This is what makes the breaker
     work without a daemon: the ledger is the session, and every seam already writes to
     it. A trip is reported here and enforced on the next command, because this one has
     already run — stopping it now would be a receipt rather than a control. */
  const tripped = await observeSession({
    home,
    sessionId: process.env[SESSION_VAR],
  });
  if (tripped !== null) process.stderr.write(`${pauseMessage(tripped)}\n`);

  process.exit(status);
}

/**
 * Hand over stdio untouched and pass the exit code straight back: anything the agent
 * reads or writes must look exactly as it would have without the interceptor.
 */
function hand(binary: string, args: readonly string[], home: string): number {
  const path = realPath(process.env['PATH'] ?? '', home);
  const real = resolveReal(binary, path, existsSync);
  if (real === null) {
    process.stderr.write(`memnox: ${binary} is not on PATH behind the interceptor\n`);
    process.exit(127);
  }
  const result = spawnSync(real, [...args], {
    stdio: 'inherit',
    env: { ...process.env, PATH: path },
  });
  return result.status ?? 1;
}

void main();
