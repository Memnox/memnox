import { ACTION_CLASS, CLASS_BASIS, classifyActionClass } from '@memnox/core';

/** Neither an agent id nor a session id can contain it, so a key is unambiguous. */
const KEY_SEPARATOR = '::';

/** One action as the ledger recorded it, which is all this needs to see. */
export interface SequenceObservation {
  agentId: string;
  sessionId: string;
  action: string;
  target?: string;
  at: string;
}

/** One of the three steps, with what it actually was. */
export interface SequenceStep {
  action: string;
  target?: string;
  at: string;
}

/**
 * Read a customer. Write a file. Send it somewhere. Each one is ordinary, each is
 * allowed, and no evaluator looking at a single action will ever see the third coming.
 */
export interface CombinedSequence {
  agentId: string;
  sessionId: string;
  read: SequenceStep;
  write: SequenceStep;
  send: SequenceStep;
}

/**
 * The combination, as it was actually performed rather than merely held.
 *
 * Limit: one machine, one session, in order. Two agents on two machines completing the
 * same shape between them is the joined ledger's question, and this cannot see it.
 */
export function combinedSequences(
  observations: readonly SequenceObservation[],
): CombinedSequence[] {
  const bySession = new Map<string, SequenceObservation[]>();
  for (const observation of observations) {
    const key = `${observation.agentId}${KEY_SEPARATOR}${observation.sessionId}`;
    bySession.set(key, [...(bySession.get(key) ?? []), observation]);
  }

  const found: CombinedSequence[] = [];
  for (const session of bySession.values()) {
    const ordered = [...session].sort((a, b) => a.at.localeCompare(b.at));
    const sequence = firstSequenceIn(ordered);
    if (sequence !== null) found.push(sequence);
  }
  return found.sort((a, b) => a.read.at.localeCompare(b.read.at));
}

/**
 * In order, and only in order: a send before the read it would have carried is not
 * an export, and reporting it as one would be the kind of false positive that gets
 * the whole finding ignored.
 */
function firstSequenceIn(
  ordered: readonly SequenceObservation[],
): CombinedSequence | null {
  let read: SequenceObservation | undefined;
  let write: SequenceObservation | undefined;

  for (const observation of ordered) {
    const classification = classifyActionClass(observation.action);

    if (read === undefined) {
      if (classification.basis === CLASS_BASIS.READ_VERB) read = observation;
      continue;
    }
    if (write === undefined) {
      if (
        classification.class === ACTION_CLASS.LOCAL &&
        classification.basis !== CLASS_BASIS.READ_VERB
      ) {
        write = observation;
      }
      continue;
    }
    if (classification.basis === CLASS_BASIS.OUTWARD) {
      return {
        agentId: observation.agentId,
        sessionId: observation.sessionId,
        read: stepOf(read),
        write: stepOf(write),
        send: stepOf(observation),
      };
    }
  }
  return null;
}

function stepOf(observation: SequenceObservation): SequenceStep {
  return {
    action: observation.action,
    ...(observation.target === undefined ? {} : { target: observation.target }),
    at: observation.at,
  };
}
