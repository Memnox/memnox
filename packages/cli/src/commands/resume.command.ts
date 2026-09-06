import { homedir, userInfo } from 'node:os';
import type { Command } from 'commander';
import { SessionPauses } from '@memnox/core';
import type { CliContext } from '../cli-context';

/**
 * Lifting a hold.
 *
 * A stop nobody can undo is one people work around by uninstalling, so this exists
 * from the first day the breaker does. Who lifted it stays in the record: "somebody
 * resumed it" is not an answer anybody can act on afterwards.
 */
export function registerResumeCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
  now: () => Date = () => new Date(),
): void {
  program
    .command('paused')
    .description('Sessions Memnox is holding, and why')
    .action(async () => {
      const held = (await new SessionPauses(home()).all()).filter(
        (pause) => pause.resumedAt === undefined,
      );
      if (held.length === 0) {
        context.out.line('Nothing is paused.');
        return;
      }
      for (const pause of held) {
        context.out.line(`  ${pause.sessionId}  ${pause.signal}`);
        context.out.line(`    ${context.style.dim(pause.reason)}`);
        if (pause.lastAction !== undefined) {
          context.out.line(`    ${context.style.dim(`last: ${pause.lastAction}`)}`);
        }
      }
      context.out.note('Lift one with "memnox resume <session> --by <you>".');
    });

  program
    .command('resume <session>')
    .description('Let a paused session carry on')
    .option('--by <who>', 'who is lifting it', userInfo().username)
    .action(async (session: string, options: { by: string }) => {
      const pauses = new SessionPauses(home());
      const resumed = await pauses.resume(session, options.by, now().toISOString());
      if (resumed === null) {
        throw new Error(`${session} is not paused.`);
      }
      context.out.line(`Resumed ${session}.`);
      // What stopped it is still true; saying so is the difference between lifting and forgetting.
      context.out.note(`It was held because ${resumed.reason}.`);
      context.out.note(
        'The next command in that session runs; nothing needs restarting.',
      );
    });
}
