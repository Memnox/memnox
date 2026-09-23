/**
 * The one acting tool: the working tree back to before a session, or to a milestone. The
 * host asks the person first, this refuses where nobody could have, and every request is recorded.
 */
import {
  ACTOR_TYPE,
  DECISION_EFFECT,
  EVENT_SCHEMA_VERSION,
  EVENT_SURFACE,
  EXECUTION,
  loadOrCreateConfig,
  milestonesOfSession,
  newEventId,
  openLedger,
  RewindRefused,
  SESSION_VAR,
  TOOL_CLASS,
  type DecisionEffect,
  type Milestone,
  type Milestones,
} from '@memnox/core';

import { textArg, type SessionToolDeps, type ToolArgs } from './read-tools';

/** The ledger's word for a rewind an agent asked for, beside the seams' own operations. */
export const REWIND_OPERATION = 'memnox.rewind';

/** A request made outside `memnox run` still needs a session, so the agent's own stands in. */
const TOOLS_SESSION_PREFIX = 'ses_tools_';

/** How a rewind request reaches the person, and whether one can. */
export interface RewindSeams {
  build: (cwd: string) => Milestones;
  /** CI or a headless run: nobody could have approved, whatever the host says. */
  unattended: () => boolean;
  /** A terminal a person sits at, which is where the host's own prompt appears. */
  terminal: () => boolean;
  /** Asks the person through the host where it can; null where the host offers no way. */
  confirm: (message: string) => Promise<boolean | null>;
}

const NOBODY_THERE =
  'Nobody is at this machine to approve a rewind, so none was done. Run "memnox rewind" yourself.';

interface Outcome {
  effect: DecisionEffect;
  reason: string;
  target?: string;
  answer: Record<string, unknown>;
}

/** Runs one request and records it, whichever way it went. */
export async function rewindTool(
  deps: SessionToolDeps,
  seams: RewindSeams,
  args: ToolArgs,
): Promise<unknown> {
  const outcome = await decide(deps, seams, args);
  await recordRequest(deps, outcome);
  return outcome.answer;
}

function refused(reason: string, target?: string): Outcome {
  return {
    effect: DECISION_EFFECT.DENY,
    reason,
    ...(target === undefined ? {} : { target }),
    answer: { rewound: false, refused: reason },
  };
}

async function decide(
  deps: SessionToolDeps,
  seams: RewindSeams,
  args: ToolArgs,
): Promise<Outcome> {
  if (seams.unattended()) return refused(NOBODY_THERE);
  const milestones = seams.build(deps.cwd);
  let target: Milestone;
  try {
    target = await targetOf(milestones, args);
  } catch (err) {
    return refused(describe(err));
  }
  const asked = await seams.confirm(
    `Rewind the working tree in ${deps.cwd} to ${target.id}, taken ${target.takenAt}? Your current files are kept first.`,
  );
  if (asked === false) return refused('The person said no.', target.id);
  // No way to ask through the host, so only a terminal's permission prompt stands in.
  if (asked === null && !seams.terminal()) return refused(NOBODY_THERE, target.id);
  return restore(deps, milestones, target);
}

async function restore(
  deps: SessionToolDeps,
  milestones: Milestones,
  target: Milestone,
): Promise<Outcome> {
  try {
    // restore keeps the tree as it is now before it moves a file, so this is undoable.
    const { restored, kept } = await milestones.restore(
      target.id,
      deps.now().toISOString(),
    );
    return {
      effect: DECISION_EFFECT.ALLOW,
      reason: `Rewound to ${restored.id}; the tree before it is kept as ${kept.id}.`,
      target: restored.id,
      answer: {
        rewound: true,
        backTo: restored.id,
        takenAt: restored.takenAt,
        yourWorkKeptAs: kept.id,
        undo: `memnox rewind --to ${kept.id}`,
        said: 'Only files moved. No commit, branch or stash was touched.',
      },
    };
  } catch (err) {
    return refused(describe(err), target.id);
  }
}

function describe(err: unknown): string {
  if (err instanceof RewindRefused || err instanceof Error) return err.message;
  return String(err);
}

/** The milestone named, else the first of the session named, else of the newest session. */
async function targetOf(milestones: Milestones, args: ToolArgs): Promise<Milestone> {
  const found = await milestones.list();
  const to = textArg(args, 'milestone');
  if (to !== undefined) {
    const named = found.find((each) => each.id === to);
    if (named === undefined) throw new Error(`No milestone ${to} here.`);
    return named;
  }
  const session =
    textArg(args, 'session') ??
    found.find((each) => each.sessionId !== undefined)?.sessionId;
  const first =
    session === undefined ? undefined : milestonesOfSession(found, session)[0];
  if (first === undefined) {
    throw new Error(
      'No milestone here belongs to a session yet, so there is nothing to rewind to.',
    );
  }
  return first;
}

/** One ledger row per request, so `why` and `timeline` show that an agent asked. */
async function recordRequest(deps: SessionToolDeps, outcome: Outcome): Promise<void> {
  const ledger = openLedger(deps.home);
  if (ledger === null) return;
  try {
    const { mode } = await loadOrCreateConfig(deps.home);
    await ledger.append({
      id: newEventId(),
      schemaVersion: EVENT_SCHEMA_VERSION,
      at: deps.now().toISOString(),
      sessionId: deps.env[SESSION_VAR] ?? `${TOOLS_SESSION_PREFIX}${deps.agent}`,
      agent: deps.agent,
      actorType: ACTOR_TYPE.AGENT,
      surface: EVENT_SURFACE.FILESYSTEM,
      operation: REWIND_OPERATION,
      ...(outcome.target === undefined ? {} : { target: outcome.target }),
      class: TOOL_CLASS.DESTRUCTIVE,
      effect: outcome.effect,
      mode,
      reason: outcome.reason,
      execution:
        outcome.effect === DECISION_EFFECT.ALLOW
          ? EXECUTION.COMPLETED
          : EXECUTION.BLOCKED,
    });
  } finally {
    ledger.close();
  }
}
