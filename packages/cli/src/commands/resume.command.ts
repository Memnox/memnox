import { homedir, userInfo } from 'node:os';
import type { Command } from 'commander';
import { SessionPauses } from '@memnox/core';
import type { CliContext } from '../cli-context';
import { TONE } from '../flow';

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
      const { flow } = context;
      flow.open('memnox paused');
      const held = (await new SessionPauses(home()).all()).filter(
        (pause) => pause.resumedAt === undefined,
      );
      if (held.length === 0) {
        flow.close('Nothing is paused.');
        return;
      }
      flow.list(
        'Held',
        held.map((pause) => ({
          tone: TONE.WARN,
          text: `${pause.sessionId}  ${pause.signal}`,
          detail: [
            pause.reason,
            pause.lastAction === undefined ? undefined : `last: ${pause.lastAction}`,
          ],
        })),
      );
      flow.close(
        `${held.length === 1 ? '1 session is' : `${held.length} sessions are`} held.`,
      );
      flow.hint('Lift one with "memnox resume <session> --by <you>".');
    });

  program
    .command('resume <session>')
    .description('Let a paused session carry on')
    .option('--by <who>', 'who is lifting it', userInfo().username)
    .action(async (session: string, options: { by: string }) => {
      const { flow, style } = context;
      flow.open('memnox resume');
      const pauses = new SessionPauses(home());
      const resumed = await pauses.resume(session, options.by, now().toISOString());
      if (resumed === null) {
        throw new Error(`${session} is not paused.`);
      }
      flow.rows('Resumed', [
        { label: 'session', value: session },
        { label: 'by', value: options.by },
        // What stopped it is still true; saying so is the difference between
        // lifting a hold and forgetting one.
        { label: 'was held', value: `because ${resumed.reason}` },
      ]);
      flow.close(style.ok(`${session} carries on.`));
      flow.hint('The next command in that session runs; nothing needs restarting.');
    });
}
