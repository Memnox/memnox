import {
  ACTION_CLASS,
  CLASS_BASIS,
  LOCAL_NAMESPACES,
  OUTWARD_NAMESPACES,
  OUTWARD_VERBS,
  type ActionClass,
  type ClassBasis,
} from '../constants/action-class.constants';
import { DESTRUCTIVE_VERBS, READ_ONLY_VERBS } from '../constants/risk.constants';

/** Actions split on both "." and "_" so "slack.send_message" yields [slack, send, message]. */
const ACTION_SEGMENT_SEPARATOR = /[._]/;

export interface ActionClassification {
  action: string;
  class: ActionClass;
  /** Which rule decided it. A classification with no method is an opinion. */
  basis: ClassBasis;
}

/**
 * Which of the three classes an action falls in, from its namespace and its verb and
 * from nothing else. Deterministic, because this is read at the moment somebody is
 * deciding whether an action leaves the machine, and a guess there is worse than none.
 *
 * It classifies. It never decides: the effect is the policy engine's, and this is the
 * evidence a rule is written against.
 */
export function classifyActionClass(action: string): ActionClassification {
  const lowered = action.toLowerCase();
  const segments = lowered.split(ACTION_SEGMENT_SEPARATOR).filter((part) => part !== '');
  const namespace = segments[0] ?? lowered;
  const verbs = segments.slice(1).length === 0 ? segments : segments.slice(1);

  if (verbs.some((verb) => DESTRUCTIVE_VERBS.includes(verb))) {
    return classified(action, ACTION_CLASS.DESTRUCTIVE, CLASS_BASIS.DESTRUCTIVE_VERB);
  }
  if (OUTWARD_NAMESPACES.includes(namespace)) {
    return classified(action, ACTION_CLASS.EXTERNAL_STATE, CLASS_BASIS.OUTWARD);
  }
  if (verbs.some((verb) => OUTWARD_VERBS.includes(verb))) {
    return classified(action, ACTION_CLASS.EXTERNAL_STATE, CLASS_BASIS.OUTWARD);
  }
  // A read creates nothing outside the machine, wherever it reads from.
  if (verbs.some((verb) => READ_ONLY_VERBS.includes(verb))) {
    return classified(action, ACTION_CLASS.LOCAL, CLASS_BASIS.READ_VERB);
  }
  if (LOCAL_NAMESPACES.includes(namespace)) {
    return classified(action, ACTION_CLASS.LOCAL, CLASS_BASIS.LOCAL_NAMESPACE);
  }
  return classified(action, ACTION_CLASS.EXTERNAL_STATE, CLASS_BASIS.UNPROVEN);
}

function classified(
  action: string,
  actionClass: ActionClass,
  basis: ClassBasis,
): ActionClassification {
  return { action, class: actionClass, basis };
}

/** One line a person reads: the class and what proved it. */
export function describeActionClass(classification: ActionClassification): string {
  const reason: Record<ClassBasis, string> = {
    [CLASS_BASIS.DESTRUCTIVE_VERB]: 'the verb destroys or exfiltrates',
    [CLASS_BASIS.OUTWARD]: 'outward communication, addressed to people',
    [CLASS_BASIS.READ_VERB]: 'a read changes nothing outside the machine',
    [CLASS_BASIS.LOCAL_NAMESPACE]: 'nothing here leaves the machine',
    [CLASS_BASIS.UNPROVEN]: 'nothing proved this stays on the machine',
  };
  return `${classification.class}: ${reason[classification.basis]}`;
}
