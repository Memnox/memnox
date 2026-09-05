import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import { LocalGate } from '@memnox/core';
import type { CliContext } from '../cli-context';
import { MemnoxDaemon } from '../daemon-server';
import { resolvePolicyFile } from '../policy-path';
import { readAccount } from '../sync/account';
import { syncLoop } from '../sync/heartbeat';

export function registerDaemonCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
): void {
  program
    .command('daemon')
    .description('Hold the rules in one process, so an interceptor pays a connect')
    .option('-f, --file <path>', 'policy file (default: whichever exists)')
    .option('--no-sync', 'hold the rules but talk to nothing')
    .action(async (options: { file?: string; sync: boolean }) => {
      const file = resolvePolicyFile(options.file);
      const gate = existsSync(file)
        ? await LocalGate.fromFiles([file], { agentName: 'agent' })
        : undefined;

      const daemon = new MemnoxDaemon({
        ...(gate === undefined ? {} : { gate }),
        log: (message) => context.out.note(message),
      });

      const path = await daemon.listen(home());
      context.out.line(`Listening on ${path}`);
      if (gate === undefined) {
        context.out.note(`No rules at ${file}; everything will be allowed.`);
      }
      context.out.note(
        'Ctrl-C to stop. Interceptors fall back to in-process if this is not running.',
      );

      /* The sync rides here rather than in its own process: this is already the
         one thing that outlives a command, and a second daemon is a second thing
         to notice has died. With no account it makes no call at all. */
      let running = true;
      const account = options.sync ? await readAccount(home()) : null;
      if (account === null) {
        context.out.note(
          options.sync
            ? 'Not logged in, so nothing is pulled or sent. "memnox login" connects it.'
            : 'Sync off; this daemon talks to nothing.',
        );
      } else {
        context.out.note(`Syncing with ${account.baseUrl} as ${account.machineId}.`);
        void syncLoop(home(), () => running, {
          log: (message) => context.out.note(message),
        });
      }

      // Held open deliberately: the command is the daemon, not a launcher for one.
      await new Promise<void>((resolve) => {
        const stop = (): void => {
          running = false;
          void daemon.close().then(resolve);
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    });
}
