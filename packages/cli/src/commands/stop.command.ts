import { homedir } from 'node:os';
import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { daemonPaths, readDaemonPid, stopDaemon } from '../runtime-daemon';

/**
 * The other half of a `setup` that returns the prompt: something has to end the
 * process the terminal no longer owns. Only stops a runtime started here — a
 * `memnox serve` in the foreground belongs to whoever ran it.
 */
export function registerStopCommand(
  program: Command,
  context: CliContext,
  homeDir: string = homedir(),
): void {
  program
    .command('stop')
    .description('Stop the background runtime that "memnox setup" started')
    .action(async () => {
      const { out, style } = context;
      const paths = daemonPaths(homeDir);
      const running = await readDaemonPid(paths);
      const stopped = await stopDaemon(paths);

      if (stopped === null) {
        out.line(style.warn('No background runtime is running.'));
        if (running === null) {
          out.note(
            style.dim('→ A foreground "memnox serve" is stopped with Ctrl+C instead.'),
          );
        }
        return;
      }
      out.line(`Stopped the runtime (pid ${stopped}).`);
    });
}
