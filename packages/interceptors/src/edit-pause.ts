import {
  CloudLeases,
  CloudNotes,
  desktopNotice,
  LeaseRegistry,
  markActivity,
  MINUTE_MS,
  NOTE_KIND,
  renderNotes,
  SECOND_MS,
  SqliteEventStore,
  type SessionNote,
} from '@memnox/core';

import { EDIT_HOST } from './agent-edits';
import { takeOverIfAllowed, type EditHookContext } from './edit-claims';
import { EDIT_IDLE_MINUTES } from './edit-hook';
import { markIfDue } from './edit-marks';
import {
  activityOf,
  SESSION_MOMENT,
  sessionAnswer,
  type SessionEvent,
} from './session-events';

/**
 * A tool call returned or a turn ended: write down what the agent did, keep its holds
 * alive, and hand it whatever is waiting for its session, in the words its host reads.
 */

/**
 * How often a session asks for notes after a tool
 * call, at most, since agents run tools in bursts.
 */
const NOTES_EVERY_MS = 10 * SECOND_MS;

/**
 * How often a working session renews what it holds,
 * at most, since this runs after every call.
 */
const RENEW_EVERY_MS = MINUTE_MS;

/**
 * What the host reads back at this pause, with a trailing newline, or empty for nothing.
 * `said` is anything else this pause carries, such as a decision the prompt names.
 */
export async function answerPause(
  pause: SessionEvent,
  context: EditHookContext,
  said: string | null = null,
): Promise<string> {
  await recordActivity(pause, context);
  if (pause.moment === SESSION_MOMENT.AFTER_TOOL) await takeOverIfAllowed(pause, context);
  const notes = await notesAt(pause, context);
  // A collision note goes on the person's screen
  // too, since they are usually in another window.
  const collided = notes.filter((note) => note.kind === NOTE_KIND.COORDINATION);
  if (collided.length > 0 && pause.host !== EDIT_HOST.WINDSURF) {
    desktopNotice(collided.map((note) => note.message).join(' '));
  }
  // A remembered decision rides beside the notes, never instead of them.
  const told = [
    ...(notes.length === 0 ? [] : [renderNotes(notes)]),
    ...(said === null ? [] : [said]),
  ];
  const answer = sessionAnswer(pause, told.length === 0 ? null : told.join('\n\n'));
  return answer === '' ? '' : `${answer}\n`;
}

async function recordActivity(
  pause: SessionEvent,
  context: EditHookContext,
): Promise<void> {
  const rows = activityOf(pause, context.agent, undefined, context.now().toISOString());
  if (rows.length === 0) return;
  try {
    const ledger = SqliteEventStore.forHome(context.home);
    try {
      for (const row of rows) await ledger.append(row);
    } finally {
      ledger.close();
    }
    await markActivity(context.home);
  } catch {
    // A lost row is a lost row; the agent's tool call already happened.
  }
}

/**
 * What to hand this session: after a tool call, at most every
 * few seconds; at a turn's end, only a person's words, since a
 * note then wakes the agent; at a prompt, everything waiting.
 */
async function notesAt(
  pause: SessionEvent,
  context: EditHookContext,
): Promise<SessionNote[]> {
  const { agent, home } = context;
  const inbox = new CloudNotes(home);
  // The holds are filed under the session `memnox run` set, where there is one.
  const holder = context.runSession ?? pause.sessionId;
  // Windsurf reads nothing back, so a note collected
  // here would be marked delivered and never seen.
  if (pause.host === EDIT_HOST.WINDSURF) {
    await keepHoldsAlive(holder, context);
    return [];
  }
  if (pause.moment === SESSION_MOMENT.TURN_END) {
    return inbox.collect(agent, pause.sessionId, [NOTE_KIND.OPERATOR]);
  }
  if (pause.moment === SESSION_MOMENT.PROMPT)
    return inbox.collect(agent, pause.sessionId);

  const chore = { name: 'notes', sessionId: pause.sessionId, everyMs: NOTES_EVERY_MS };
  const [, notes] = await Promise.all([
    keepHoldsAlive(holder, context),
    markIfDue(home, chore, context.now()).then((due) =>
      due ? inbox.collect(agent, pause.sessionId) : [],
    ),
  ]);
  return notes;
}

/**
 * The session is still working, so what it holds lasts
 * another few minutes. A missed renewal lapses early.
 */
async function keepHoldsAlive(
  sessionId: string,
  context: EditHookContext,
): Promise<void> {
  const { agent, home } = context;
  const chore = { name: 'renewed', sessionId, everyMs: RENEW_EVERY_MS };
  if (!(await markIfDue(home, chore, context.now()))) return;
  await new LeaseRegistry(home)
    .renewSession(sessionId, context.now().toISOString(), EDIT_IDLE_MINUTES)
    .catch(() => 0);
  await new CloudLeases(home)
    .renewSession({ agent, sessionId, pid: context.pid }, EDIT_IDLE_MINUTES)
    .catch(() => undefined);
}
