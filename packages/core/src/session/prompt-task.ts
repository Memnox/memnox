/**
 * What a person asked for, read from the prompt they typed, so a session has a task without
 * anybody running a command. Read by its words, never by a model: "investigate why the
 * payments failed" is an investigation, "investigate and fix it" is not.
 */
import { TASK_INTENT, taskFor, type SessionTask, type TaskIntent } from './session-task';

/** Long enough to recognise the ask in `why`, short enough never to be a document. */
const MOST_STATEMENT_CHARS = 200;

/** Words that say the person wants to understand something. */
const INVESTIGATING =
  /\b(investigate|diagnose|debug why|look into|find out|figure out|root cause|what happened|what caused|why (did|does|do|is|are|was|were)|audit|inspect|analy[sz]e)\b/;

/** Words that say the person wants something changed, which ends an investigation. */
const CHANGING =
  /\b(fix|implement|change|update|add|remove|delete|refactor|deploy|write|create|build|rename|migrate|patch|upgrade|install|commit|push|merge|release|revert|make|set up|configure|restart|rollback|roll back)\b/;

/** Words that hold the session to reading whatever else the prompt says. */
const HANDS_OFF =
  /\b(don'?t change|do not change|without changing|change nothing|read[- ]only|don'?t touch|do not touch|just look|only look)\b/;

/** An investigation when the prompt says so outright, or asks why and asks for no change. */
export function intentOfPrompt(prompt: string): TaskIntent | undefined {
  const text = prompt.toLowerCase();
  if (HANDS_OFF.test(text)) return TASK_INTENT.INVESTIGATE;
  if (INVESTIGATING.test(text) && !CHANGING.test(text)) return TASK_INTENT.INVESTIGATE;
  return undefined;
}

/** The first line of the prompt, clipped, which is the ask as the person put it. */
export function statementOfPrompt(prompt: string): string {
  const line = prompt.trim().split('\n')[0] ?? '';
  return line.length <= MOST_STATEMENT_CHARS
    ? line
    : `${line.slice(0, MOST_STATEMENT_CHARS - 1)}…`;
}

/**
 * The task a prompt declares, or null for one that declares nothing to go on. A task a
 * person declared by hand is never replaced by one read from a prompt.
 */
export function taskFromPrompt(
  prompt: string,
  existing: SessionTask | null,
  moment: { sessionId: string; now: string },
): SessionTask | null {
  if (existing !== null && existing.declaredBy !== DECLARED_BY_PROMPT) return null;
  const statement = statementOfPrompt(prompt);
  if (statement === '') return null;
  const intent = intentOfPrompt(prompt);
  return {
    ...taskFor(
      {
        sessionId: moment.sessionId,
        statement,
        scope: {},
        ...(intent === undefined ? {} : { intent }),
      },
      moment.now,
    ),
    declaredBy: DECLARED_BY_PROMPT,
  };
}

/** A task read from the session's prompt rather than declared by a person. */
export const DECLARED_BY_PROMPT = 'prompt';
