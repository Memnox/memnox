/**
 * `memnox replay`: one session step by step, in the order it happened, with the actions
 * right before a failure or a breaker trip marked, so a postmortem starts from the record.
 */

import { homedir } from 'node:os';
import type { Command } from 'commander';
import {
  buildReplay,
  FileCheckpointMarks,
  LEDGER_LATEST_ONLY,
  LEDGER_SESSION_LIMIT,
  Milestones,
  NodeGit,
  NodeWorktree,
  PendingApprovals,
  REPLAY_END,
  REPLAY_STEP,
  SessionPauses,
  type Milestone,
  type ReplayStep,
  type SessionReplay,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { withEvents } from '../event-store';
import { TONE, type FlowItem } from '../flow';

const TIME_OF_DAY_START = 'YYYY-MM-DDT'.length;
const TIME_OF_DAY_END = TIME_OF_DAY_START + 'HH:MM:SS'.length;

interface ReplayOptions {
  last?: boolean;
  json?: boolean;
}

interface ReplayDeps {
  home: () => string;
  cwd: () => string;
  now: () => Date;
  /** The milestones kept in one directory's repository. */
  milestonesAt: (place: string) => Promise<Milestone[]>;
}

async function milestonesIn(place: string): Promise<Milestone[]> {
  try {
    return await new Milestones(new NodeGit(place), new NodeWorktree(place)).list();
  } catch {
    // Not a repository, or no longer there: it simply kept no milestones.
    return [];
  }
}

export function registerReplayCommand(
  program: Command,
  context: CliContext,
  overrides: Partial<ReplayDeps> = {},
): void {
  const deps: ReplayDeps = {
    home: homedir,
    cwd: () => process.cwd(),
    now: () => new Date(),
    milestonesAt: milestonesIn,
    ...overrides,
  };
  program
    .command('replay [session]')
    .description(
      'Step through what one session did, and what came right before it failed',
    )
    .option('--last', 'the most recent session, which is also what no session means')
    .option('--json', 'machine-readable output')
    .action(async (session: string | undefined, options: ReplayOptions) =>
      runReplay(context, deps, session, options),
    );
}

async function runReplay(
  context: CliContext,
  deps: ReplayDeps,
  session: string | undefined,
  options: ReplayOptions,
): Promise<void> {
  if (options.json !== true) context.flow.open('memnox replay');
  const replay = await replayOf(deps, options.last === true ? undefined : session);
  if (options.json === true) {
    context.out.json(replay);
    return;
  }
  render(context, replay);
}

/** Every record about the session, gathered from the ledger, the pauses, holds and repositories. */
async function replayOf(
  deps: ReplayDeps,
  asked: string | undefined,
): Promise<SessionReplay> {
  const home = deps.home();
  const { sessionId, events } = await withEvents(home, async (store) => {
    const id = asked ?? (await store.query({ limit: LEDGER_LATEST_ONLY }))[0]?.sessionId;
    if (id === undefined) {
      throw new Error('Nothing recorded yet, so there is no session to replay.');
    }
    return {
      sessionId: id,
      events: await store.query({ sessionId: id, limit: LEDGER_SESSION_LIMIT }),
    };
  });
  return buildReplay({
    sessionId,
    events,
    pause: await new SessionPauses(home).read(sessionId),
    pending: await new PendingApprovals(home).list(deps.now().toISOString()),
    milestones: await milestonesOf(deps, sessionId),
  });
}

/** Where the session kept milestones, as the seams marked it, and wherever this is run. */
async function milestonesOf(deps: ReplayDeps, sessionId: string): Promise<Milestone[]> {
  const marks = await new FileCheckpointMarks(deps.home()).read();
  const places = new Set([
    deps.cwd(),
    ...marks.filter((mark) => mark.sessionId === sessionId).map((mark) => mark.place),
  ]);
  const found = new Map<string, Milestone>();
  for (const place of places) {
    for (const milestone of await deps.milestonesAt(place)) {
      if (milestone.sessionId === sessionId) found.set(milestone.id, milestone);
    }
  }
  return [...found.values()];
}

function render(context: CliContext, replay: SessionReplay): void {
  const { flow, style } = context;
  if (replay.steps.length === 0) {
    flow.close(`Nothing recorded for session ${replay.sessionId}.`);
    flow.hint('"memnox timeline" lists the sessions there are.');
    return;
  }
  flow.rows('Session', [
    { label: 'session', value: replay.sessionId },
    ...(replay.agent === undefined ? [] : [{ label: 'agent', value: replay.agent }]),
    { label: 'from', value: replay.startedAt ?? '' },
    { label: 'to', value: replay.endedAt ?? '' },
  ]);
  flow.list('What happened, in order', replay.steps.map(itemOf));
  if (replay.end === REPLAY_END.CLEAN) {
    flow.close(
      style.ok(`${replay.steps.length} step(s), and nothing went wrong on the record.`),
    );
  } else {
    flow.close(style.warn(`${endingOf(replay)}: ${replay.endReason ?? ''}`));
    flow.hint(
      'The marked steps are what came right before it. "memnox trace <id>" opens one.',
    );
  }
  flow.hint(
    `Back to before it changed anything: "memnox rewind --session ${replay.sessionId}".`,
  );
}

function endingOf(replay: SessionReplay): string {
  if (replay.end === REPLAY_END.TRIPPED) return 'The breaker paused it';
  if (replay.end === REPLAY_END.FAILED) return 'It ended on a failure';
  return 'It went on past a failure';
}

/** One step as a line: the time, what happened, and the row to trace for an action. */
function itemOf(step: ReplayStep): FlowItem {
  const at = step.at.slice(TIME_OF_DAY_START, TIME_OF_DAY_END);
  const lead = step.leadUp === true ? '> ' : '  ';
  const text = `${at}  ${lead}${step.summary}`;
  // Only the lead up earns its reasons, or a long session reads as a wall.
  const detail =
    step.leadUp === true
      ? [step.reason, step.eventId === undefined ? undefined : `trace ${step.eventId}`]
      : [];
  return { tone: toneOf(step), text, detail };
}

function toneOf(step: ReplayStep): FlowItem['tone'] {
  if (step.kind === REPLAY_STEP.TRIP || step.leadUp === true) return TONE.WARN;
  if (step.kind === REPLAY_STEP.MILESTONE || step.kind === REPLAY_STEP.RESUME)
    return TONE.OK;
  return TONE.DIM;
}
