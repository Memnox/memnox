import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import {
  DECISION_EFFECT,
  isBrowserLauncher,
  readOverlays,
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
import { log } from './seam-runtime';

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

  const overlays = await readOverlays(home);
  const sink = openLedger(home);
  const started = Date.now();
  const outcome = await ruleOnCommand(binary, args, {
    ...(gate === null ? {} : { gate }),
    overlays,
    env: process.env,
    ...(process.env[SESSION_VAR] === undefined
      ? {}
      : { sessionId: process.env[SESSION_VAR] }),
    log,
  });

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
          log,
        });
        if (again.allowed) {
          await handAndRecord(basename(next), rest, home, sink, again, started);
          return;
        }
        process.stderr.write(`${again.message ?? 'denied'}\n`);
      }
    }
    await record(sink, {
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

  await handAndRecord(binary, args, home, sink, outcome, started);
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
): Promise<never> {
  const status = hand(binary, args, home);
  await record(sink, {
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
