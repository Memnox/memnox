import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { invokedAs, realPath, resolveReal, ruleOnCommand } from './interceptor';
import { loadHookGate } from './hook-gate-loader';
import { readHookConfig } from './hook-config';
import { log } from './seam-runtime';

/**
 * One binary behind every interceptor. It is invoked through a name in the interceptor directory,
 * reads which name it was called as, rules on the arguments, and only then hands over
 * to the real binary with our directory taken off PATH.
 */
async function main(): Promise<void> {
  const binary = invokedAs(process.argv[1] ?? 'memnox-intercept');
  const args = process.argv.slice(2);
  const home = homedir();

  const config = await readHookConfig(process.env, home);
  const gate = await loadHookGate(config);

  const outcome = await ruleOnCommand(binary, args, {
    ...(gate === null ? {} : { gate }),
    ...(process.env['MEMNOX_SESSION'] === undefined
      ? {}
      : { sessionId: process.env['MEMNOX_SESSION'] }),
    log,
  });

  if (!outcome.allowed) {
    process.stderr.write(`${outcome.message ?? 'denied'}\n`);
    process.exit(1);
  }

  const path = realPath(process.env['PATH'] ?? '', home);
  const real = resolveReal(binary, path, existsSync);
  if (real === null) {
    process.stderr.write(`memnox: ${binary} is not on PATH behind the interceptor\n`);
    process.exit(127);
  }

  /* Hand over stdio untouched and pass the exit code straight back: anything the
     agent reads or writes must look exactly as it would have without the interceptor. */
  const result = spawnSync(real, args, {
    stdio: 'inherit',
    env: { ...process.env, PATH: path },
  });
  process.exit(result.status ?? 1);
}

void main();
