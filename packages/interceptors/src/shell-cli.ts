import { spawn } from 'node:child_process';
import { ShellSeam, SHELL_EXIT_WITHHELD } from './shell-seam';
import { buildAuthorizer, log } from './seam-runtime';

const USAGE = `Usage: memnox-shell -- <command...>

Gates one command against policy, then runs it unchanged. A refusal names an
alternative where the rule gave one, and nothing is ever rewritten on the way through.`;

function commandFrom(argv: readonly string[]): string[] {
  const separator = argv.indexOf('--');
  return separator === -1 ? [...argv] : [...argv.slice(separator + 1)];
}

async function main(): Promise<void> {
  const command = commandFrom(process.argv.slice(2));
  if (command.length === 0) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = SHELL_EXIT_WITHHELD;
    return;
  }

  const seam = new ShellSeam({
    authorizer: await buildAuthorizer(),
    workingDirectory: process.cwd(),
  });
  const outcome = await seam.gate(command);

  if (outcome.message !== undefined) log(outcome.message);
  if (outcome.run === undefined) {
    process.exitCode = outcome.exitCode;
    return;
  }

  // Allowed: run it unchanged, and let its exit code be the one the caller sees.
  const [executable, ...args] = outcome.run;
  if (executable === undefined) return;
  const child = spawn(executable, args, { stdio: 'inherit' });
  child.on('exit', (code) => {
    process.exitCode = code === null ? SHELL_EXIT_WITHHELD : code;
  });
  child.on('error', (err: unknown) => {
    log(`could not run the command: ${String(err)}`);
    process.exitCode = SHELL_EXIT_WITHHELD;
  });
}

main().catch((err: unknown) => {
  // A wrapper that throws must not read as a refusal; it ruled on nothing and says so.
  log(`shell seam failed, ruling on nothing: ${String(err)}`);
  process.exitCode = SHELL_EXIT_WITHHELD;
});
