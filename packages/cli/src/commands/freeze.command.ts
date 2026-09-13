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
import { TONE } from '../flow';
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
  program
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
        const { flow, style } = context;
        flow.open('memnox freeze');
        const moment = now().toISOString();
        const overlays = await readOverlays(home());

        if (options.lift !== undefined && options.lift !== false) {
          const active = inForce(overlays, moment);
          const wanted =
            typeof options.lift === 'string'
              ? active.filter((each) => each.id === options.lift)
              : active;

          if (wanted.length === 0) {
            flow.close('Nothing is frozen right now.');
            return;
          }
          for (const overlay of wanted) overlay.liftedAt = moment;
          await writeOverlays(home(), overlays);
          flow.list(
            'Lifted',
            wanted.map((overlay) => ({
              tone: TONE.OK,
              text: `${overlay.kind}:${overlay.subject}`,
              detail: [overlay.reason],
            })),
          );
          flow.close(
            `${wanted.length === 1 ? '1 freeze is' : `${wanted.length} freezes are`} lifted.`,
          );
          return;
        }

        if (subject === undefined) {
          const active = inForce(overlays, moment);
          if (active.length === 0) {
            flow.close('Nothing is frozen right now.');
            flow.hint('Freeze something with "memnox freeze <subject> --for 2h".');
            return;
          }
          flow.list(
            'In force',
            active.map((overlay) => ({
              tone: TONE.WARN,
              text: describeOverlay(overlay, moment),
              detail: [`lifts itself at ${overlay.validUntil}`],
            })),
          );
          flow.close(
            `${active.length === 1 ? '1 freeze is' : `${active.length} freezes are`} in force.`,
          );
          flow.hint('End one early with "memnox freeze --lift <id>".');
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

        flow.rows('Frozen', [
          { label: 'what', value: describeOverlay(overlay, moment) },
          { label: 'because', value: overlay.reason },
          // It ends by itself, which is the whole reason this is not a policy edit.
          { label: 'lifts at', value: overlay.validUntil },
          {
            label: 'rule',
            value: `anything matching state "freeze:${subject}" now bites`,
          },
        ]);
        flow.close(style.warn(`${subject} is frozen.`));
        flow.hint('It lifts itself; nothing has to remember to.');
        flow.hint('End it early with "memnox freeze --lift".');
      },
    );
}
