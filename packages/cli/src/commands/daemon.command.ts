import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import { LocalGate } from '@memnox/core';
import type { CliContext } from '../cli-context';
import { MemnoxDaemon } from '../daemon-server';
import { DEFAULT_POLICY_FILE } from '../defaults';

export function registerDaemonCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
): void {
  program
    .command('daemon')
    .description('Hold the rules in one process, so an interceptor pays a connect')
    .option('-f, --file <path>', 'policy file', DEFAULT_POLICY_FILE)
    .action(async (options: { file: string }) => {
      const gate = existsSync(options.file)
        ? await LocalGate.fromFiles([options.file], { agentName: 'agent' })
        : undefined;

      const daemon = new MemnoxDaemon({
        ...(gate === undefined ? {} : { gate }),
        log: (message) => context.out.note(message),
      });

      const path = await daemon.listen(home());
      context.out.line(`Listening on ${path}`);
      if (gate === undefined) {
        context.out.note(`No rules at ${options.file}; everything will be allowed.`);
      }
      context.out.note(
        'Ctrl-C to stop. Interceptors fall back to in-process if this is not running.',
      );

      // Held open deliberately: the command is the daemon, not a launcher for one.
      await new Promise<void>((resolve) => {
        const stop = (): void => {
          void daemon.close().then(resolve);
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    });
}
