/**
 * `memnox freeze`: a rule that is true for a while and ends on its own, because a freeze
 * somebody has to remember to lift outlives its incident and the next one gets ignored.
 */

import { homedir, userInfo } from 'node:os';
import type { Command } from 'commander';
import {
  DEFAULT_FREEZE_MINUTES,
  describeOverlay,
  freezeFor,
  inForce,
  readOverlays,
  type Overlay,
  validateOverlay,
  writeOverlays,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { describeCount } from '../plural';
import { minutesFrom } from '../duration';
import { TONE } from '../flow';

interface FreezeOptions {
  for: string;
  reason?: string;
  lift?: boolean | string;
}

interface FreezeDeps {
  home: () => string;
  now: () => Date;
  // Who set the freeze, recorded as its source.
  who: () => string;
}

/** Everything one run of the command reads before it acts. */
interface FreezeRun {
  context: CliContext;
  home: string;
  moment: string;
  overlays: readonly Overlay[];
}

export function registerFreezeCommand(
  program: Command,
  context: CliContext,
  overrides: Partial<FreezeDeps> = {},
): void {
  const deps: FreezeDeps = {
    home: homedir,
    now: () => new Date(),
    who: () => userInfo().username,
    ...overrides,
  };
  program
    .command('freeze [subject]')
    .description('Stop external-state actions for a while, then let them resume')
    .option('--for <duration>', 'how long, e.g. 2h', String(DEFAULT_FREEZE_MINUTES))
    .option('--reason <why>', 'why, in the words the refusal will use')
    .option('--lift [id]', 'end one early, or all of them')
    .action(async (subject: string | undefined, options: FreezeOptions) =>
      runFreeze(context, deps, subject, options),
    );
}

/** Lift what is frozen, list what is frozen, or freeze the subject that was named. */
async function runFreeze(
  context: CliContext,
  deps: FreezeDeps,
  subject: string | undefined,
  options: FreezeOptions,
): Promise<void> {
  context.flow.open('memnox freeze');
  const home = deps.home();
  const run: FreezeRun = {
    context,
    home,
    moment: deps.now().toISOString(),
    overlays: await readOverlays(home),
  };
  if (options.lift !== undefined && options.lift !== false) {
    return runLift(run, options.lift);
  }
  if (subject === undefined) return renderInForce(run);
  return runFreezeSubject(run, { subject, who: deps.who(), options });
}

function describeFreezes(amount: number): string {
  return describeCount(amount, 'freeze is', 'freezes are');
}

/** Ends one freeze early, or every one in force. */
async function runLift(run: FreezeRun, lift: true | string): Promise<void> {
  const { flow } = run.context;
  const active = inForce(run.overlays, run.moment);
  const wanted =
    typeof lift === 'string' ? active.filter((each) => each.id === lift) : active;
  if (wanted.length === 0) {
    flow.close('Nothing is frozen right now.');
    return;
  }
  for (const overlay of wanted) overlay.liftedAt = run.moment;
  await writeOverlays(run.home, run.overlays);
  flow.list(
    'Lifted',
    wanted.map((overlay) => ({
      tone: TONE.OK,
      text: `${overlay.kind}:${overlay.subject}`,
      detail: [overlay.reason],
    })),
  );
  flow.close(`${describeFreezes(wanted.length)} lifted.`);
}

/** What is frozen right now, and when each lifts itself. */
function renderInForce(run: FreezeRun): void {
  const { flow } = run.context;
  const active = inForce(run.overlays, run.moment);
  if (active.length === 0) {
    flow.close('Nothing is frozen right now.');
    flow.hint('Freeze something with "memnox freeze <subject> --for 2h".');
    return;
  }
  flow.list(
    'In force',
    active.map((overlay) => ({
      tone: TONE.WARN,
      text: describeOverlay(overlay, run.moment),
      detail: [`lifts itself at ${overlay.validUntil}`],
    })),
  );
  flow.close(`${describeFreezes(active.length)} in force.`);
  flow.hint('End one early with "memnox freeze --lift <id>".');
}

interface FreezeSubjectInput {
  subject: string;
  who: string;
  options: FreezeOptions;
}

/** Freezes one subject for a window it ends by itself. */
async function runFreezeSubject(
  run: FreezeRun,
  { subject, who, options }: FreezeSubjectInput,
): Promise<void> {
  const { flow, style } = run.context;
  const overlay = freezeFor({
    subject,
    reason: options.reason ?? 'frozen by hand',
    minutes: minutesFrom(options.for, '--for'),
    now: run.moment,
    source: who,
  });
  const problems = validateOverlay(overlay);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  await writeOverlays(run.home, [...run.overlays, overlay]);
  flow.rows('Frozen', [
    { label: 'what', value: describeOverlay(overlay, run.moment) },
    { label: 'because', value: overlay.reason },
    // It ends by itself, which is the whole reason this is not a policy edit.
    { label: 'lifts at', value: overlay.validUntil },
    { label: 'rule', value: `anything matching state "freeze:${subject}" now bites` },
  ]);
  flow.close(style.warn(`${subject} is frozen.`));
  flow.hint('It lifts itself; nothing has to remember to.');
  flow.hint('End it early with "memnox freeze --lift".');
}
