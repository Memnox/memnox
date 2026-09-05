import { homedir, userInfo } from 'node:os';
import type { Command } from 'commander';
import {
  DEFAULT_FREEZE_MINUTES,
  describeOverlay,
  freezeFor,
  inForce,
  readOverlays,
  validateOverlay,
  writeOverlays,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { minutesFrom } from '../duration';

/**
 * A rule that is true for a while. The point is that it ends on its own: a freeze
 * somebody has to remember to lift is a freeze that outlives its incident, and the
 * next one gets ignored.
 */
export function registerFreezeCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
  now: () => Date = () => new Date(),
): void {
  const freeze = program
    .command('freeze [subject]')
    .description('Stop external-state actions for a while, then let them resume')
    .option('--for <duration>', 'how long, e.g. 2h', String(DEFAULT_FREEZE_MINUTES))
    .option('--reason <why>', 'why, in the words the refusal will use')
    .option('--lift [id]', 'end one early, or all of them')
    .action(
      async (
        subject: string | undefined,
        options: { for: string; reason?: string; lift?: boolean | string },
      ) => {
        const moment = now().toISOString();
        const overlays = await readOverlays(home());

        if (options.lift !== undefined && options.lift !== false) {
          const active = inForce(overlays, moment);
          const wanted =
            typeof options.lift === 'string'
              ? active.filter((each) => each.id === options.lift)
              : active;

          if (wanted.length === 0) {
            context.out.line('Nothing is frozen right now.');
            return;
          }
          for (const overlay of wanted) overlay.liftedAt = moment;
          await writeOverlays(home(), overlays);
          for (const overlay of wanted) {
            context.out.line(`Lifted ${overlay.kind}:${overlay.subject}`);
          }
          return;
        }

        if (subject === undefined) {
          const active = inForce(overlays, moment);
          if (active.length === 0) {
            context.out.line('Nothing is frozen right now.');
            return;
          }
          for (const overlay of active) {
            context.out.line(`  ${describeOverlay(overlay, moment)}`);
          }
          return;
        }

        const overlay = freezeFor(
          subject,
          options.reason ?? 'frozen by hand',
          minutesFrom(options.for, '--for'),
          moment,
          userInfo().username,
        );
        const problems = validateOverlay(overlay);
        if (problems.length > 0) throw new Error(problems.join('\n'));

        overlays.push(overlay);
        await writeOverlays(home(), overlays);

        context.out.line(describeOverlay(overlay, moment));
        // It ends by itself, which is the whole reason this is not a policy edit.
        context.out.note(`It lifts itself at ${overlay.validUntil}.`);
        context.out.note(`A rule matching state "freeze:${subject}" now bites.`);
      },
    );
  void freeze;
}
