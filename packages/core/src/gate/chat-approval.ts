/**
 * A question for a person when the agent cannot show a prompt of its own: held as a call,
 * put in the session or a DM, and answered by the person's next prompt. Only the person
 * types a prompt, so a yes the agent writes itself never counts.
 */
import { digest } from '../domain/digest';
import { HOLD_ANSWER, type HoldAnswer, type HoldRequest } from './hold';
import { PendingApprovals, type PendingApproval } from './pending';
import { grantKeyFor } from './session-grants';
import {
  APPROVAL_ROUTE,
  type ApprovalRoute,
} from '../constants/approval-route.constants';

/** Whether the person's own reply in the session can answer, rather than only a DM. */
export function answersInSession(route: ApprovalRoute): boolean {
  return route !== APPROVAL_ROUTE.DM;
}

/** Long enough for somebody to come back from a meeting, short enough to be about now. */
export const CHAT_APPROVAL_MS = 30 * 60 * 1000;

/** What a held question is about, as the hook knows it. */
export interface ChatQuestion {
  sessionId: string;
  agent: string;
  action: string;
  target?: string;
  class: string;
  reason: string;
}

function grantKeyOf(question: Pick<ChatQuestion, 'action' | 'target'>): string {
  return grantKeyFor(question.action, question.target);
}

/** The held call for this question, so asking twice before an answer is one question. */
export async function openQuestionFor(
  approvals: PendingApprovals,
  question: ChatQuestion,
  moment: string,
): Promise<PendingApproval | null> {
  const key = grantKeyOf(question);
  const open = await approvals.list(moment);
  return (
    open.find(
      (each) =>
        each.request.sessionId === question.sessionId &&
        (each.request.grantKey ?? each.request.operation) === key,
    ) ?? null
  );
}

/** Writes the question down, or finds the one already waiting for the same thing. */
export async function holdInChat(
  approvals: PendingApprovals,
  question: ChatQuestion,
  route: ApprovalRoute,
  moment: string,
): Promise<PendingApproval> {
  const open = await openQuestionFor(approvals, question, moment);
  if (open !== null) return open;
  const key = grantKeyOf(question);
  const request: HoldRequest = {
    sessionId: question.sessionId,
    agent: question.agent,
    operation: question.action,
    ...(question.target === undefined ? {} : { target: question.target }),
    fingerprint: digest(`${question.sessionId}\u0000${key}`),
    reason: question.reason,
    class: question.class,
    grantKey: key,
  };
  const raised = await approvals.raise(request, moment, CHAT_APPROVAL_MS);
  const routed: PendingApproval = { ...raised, route };
  await approvals.keep(routed);
  return routed;
}

/** What the person typed, read as an answer to one held question. */
export interface ChatReply {
  id: string;
  answer: HoldAnswer;
}

/** A reply longer than this is an instruction that happens to contain "no", not an answer. */
const MOST_REPLY_CHARS = 80;

const HELD_ID = /\bapr_[a-z0-9]+_[a-z0-9]+\b/i;
const FOR_SESSION = /\b(for (this|the) session|this session|every time|always)\b/;
const REFUSING = /^(no|nope|deny|denied|don'?t|do not|refuse|reject|stop|cancel)\b/;
const ALLOWING =
  /^(yes|y|yep|yeah|ok|okay|allow|allowed|approve|approved|go ahead|go|sure|do it|proceed)\b/;

/**
 * The answer a prompt gives, or null where it is not one. A reply naming a held call by id
 * answers that one; a bare "yes" answers only when exactly one question is waiting, so a
 * yes is never spent on something the person was not looking at.
 */
export function replyOf(
  prompt: string,
  open: readonly PendingApproval[],
): ChatReply | null {
  const text = prompt.trim().toLowerCase();
  if (text === '' || text.length > MOST_REPLY_CHARS) return null;
  const named = HELD_ID.exec(text)?.[0];
  const said = text.replace(HELD_ID, '').replace(/\s+/g, ' ').trim();
  const answer = answerOf(said);
  if (answer === null) return null;
  if (named !== undefined) {
    const found = open.find((each) => each.id.toLowerCase() === named);
    return found === undefined ? null : { id: found.id, answer };
  }
  const [only, ...more] = open;
  return only === undefined || more.length > 0 ? null : { id: only.id, answer };
}

function answerOf(said: string): HoldAnswer | null {
  if (REFUSING.test(said)) return HOLD_ANSWER.DENY;
  if (!ALLOWING.test(said)) return null;
  return FOR_SESSION.test(said) ? HOLD_ANSWER.SESSION : HOLD_ANSWER.ONCE;
}

/** The questions this session is waiting on that its own prompt may answer. */
export async function openInSession(
  approvals: PendingApprovals,
  sessionId: string,
  moment: string,
): Promise<PendingApproval[]> {
  const open = await approvals.list(moment);
  return open.filter(
    (each) =>
      each.request.sessionId === sessionId &&
      each.answer === undefined &&
      answersInSession(each.route ?? APPROVAL_ROUTE.BOTH),
  );
}

/** What the agent is told when its question is held, so it knows who to ask and how. */
export function heldText(held: PendingApproval): string {
  const route = held.route ?? APPROVAL_ROUTE.BOTH;
  const where =
    route === APPROVAL_ROUTE.DM
      ? 'It was sent to the person in Slack or Discord.'
      : route === APPROVAL_ROUTE.BOTH
        ? `Ask the person to reply "allow", "allow for this session" or "deny" (${held.id}) here, or in Slack or Discord.`
        : `Ask the person to reply "allow", "allow for this session" or "deny" (${held.id}) here.`;
  return `A person has to allow this, so Memnox is holding it as ${held.id}. ${where} Try the same call again once they have answered. Doing it another way is the same action.`;
}
