import { spawn } from 'node:child_process';
import { ShellSeam, SHELL_EXIT_WITHHELD } from './shell-seam';
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

function run(executable: string, args: readonly string[]): void {
  const child = spawn(executable, args, { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    // A signalled child is not an exit code; 128+n is what a shell reports for one.
    process.exitCode =
      code === null ? (signal === null ? SHELL_EXIT_WITHHELD : 128) : code;
  });
  child.on('error', (err: unknown) => {
    log(`could not run the command: ${String(err)}`);
    process.exitCode = SHELL_EXIT_WITHHELD;
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
  const seam = new ShellSeam({
    authorizer: await buildAuthorizer(),
    workingDirectory: process.cwd(),
    env: process.env,
    hold: buildHold(),
    ...(leases === undefined ? {} : { leases }),
  });
  const outcome = await seam.gate(command);

  if (outcome.message !== undefined) log(outcome.message);
  if (outcome.run === undefined) {
    process.exitCode = outcome.exitCode;
    return;
  }

  // Allowed: handed on exactly as it arrived, so what runs is what was written.
  if (invocation.mode === SHELL_MODE.COMMAND) {
    run(shell, [...invocation.flags, '-c', invocation.line ?? '']);
    return;
  }
  const [executable, ...args] = outcome.run;
  if (executable === undefined) return;
  run(executable, args);
}

main().catch((err: unknown) => {
  // A wrapper that throws must not read as a refusal; it ruled on nothing and says so.
  log(`shell seam failed, ruling on nothing: ${String(err)}`);
  process.exitCode = SHELL_EXIT_WITHHELD;
});
