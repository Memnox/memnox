import { homedir } from 'node:os';
import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { daemonPaths, readDaemonPid, stopDaemon } from '../runtime-daemon';

/** Something has to end the process the terminal no longer owns. */
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
