import { parseQuestion, QUESTION_VERB, type QuestionVerb } from '../domain/question';
import {
  resolveAction,
  resolveShellLine,
  type ResolvedAction,
} from '../intercept/resolve';
import { verbAction, VERB_TABLES } from '../verbs/index';

/**
 * The decision to let an agent run is made once, at the start, with nothing to go on.
 * Half an hour later it reaches the one thing it should not have touched, and the choice
 * is to abandon the run or approve under pressure — which is always yes.
 *
 * This is the same engine, the same rules and the same state, run ahead of time. Nothing
 * is executed: what it produces is the list of actions an intent resolves to, for the
 * caller to put through the gate it would have gone through anyway.
 */

export const INTENT_KIND = {
  /** A command line. Resolved exactly, because it is exactly what would run. */
  COMMAND: 'command',
  /** A phrase. Resolved to every action it could mean, which is more than one. */
  PHRASE: 'phrase',
} as const;

export type IntentKind = (typeof INTENT_KIND)[keyof typeof INTENT_KIND];

export interface Preflight {
  kind: IntentKind;
  actions: ResolvedAction[];
  /** What the phrase was read as, so a wrong reading is visible rather than mysterious. */
  verb?: QuestionVerb;
  subject?: string;
  /** Said when a phrase matched nothing, rather than answering about an empty list. */
  unrecognized?: string;
}

/** The verb-table words each question verb covers. A word absent here is never guessed. */
const VERB_WORDS: Readonly<Record<QuestionVerb, readonly string[]>> = {
  [QUESTION_VERB.READ]: ['get', 'list', 'describe', 'ls', 'status', 'logs', 'cat'],
  [QUESTION_VERB.WRITE]: ['set', 'create', 'add', 'update', 'edit', 'put', 'insert'],
  [QUESTION_VERB.DELETE]: ['delete', 'destroy', 'drop', 'rm', 'remove', 'truncate'],
  [QUESTION_VERB.DEPLOY]: ['deploy', 'up', 'apply', 'rollout', 'release', 'promote'],
  [QUESTION_VERB.MERGE]: ['merge'],
  [QUESTION_VERB.PUSH]: ['push'],
  [QUESTION_VERB.SEND]: ['send', 'post', 'notify'],
  [QUESTION_VERB.APPLY]: ['apply', 'up', 'rollout'],
  [QUESTION_VERB.PUBLISH]: ['publish', 'release'],
};

/**
 * Ranked, most consequential first. A pattern like `release delete` holds a word from
 * two verbs, and the answer has to be "delete" — listing it under "deploy" would put a
 * destructive action in front of somebody who asked about shipping.
 */
const VERB_RANK: readonly QuestionVerb[] = [
  QUESTION_VERB.DELETE,
  QUESTION_VERB.PUBLISH,
  QUESTION_VERB.DEPLOY,
  QUESTION_VERB.APPLY,
  QUESTION_VERB.MERGE,
  QUESTION_VERB.PUSH,
  QUESTION_VERB.SEND,
  QUESTION_VERB.WRITE,
  QUESTION_VERB.READ,
];

/** The word in an argv pattern that decides what it is. */
function strongestWord(argv: readonly string[]): string | null {
  for (const verb of VERB_RANK) {
    const found = argv.find((word) => VERB_WORDS[verb].includes(word));
    if (found !== undefined) return found;
  }
  return null;
}

/** A command line has a binary this machine knows; a phrase is prose about one. */
function looksLikeCommand(intent: string): boolean {
  const first = intent.trim().split(/\s+/)[0];
  if (first === undefined) return false;
  return VERB_TABLES.some((table) => table.name === first) || first.includes('/');
}

export function preflightFor(intent: string, env: NodeJS.ProcessEnv = {}): Preflight {
  if (looksLikeCommand(intent)) {
    return { kind: INTENT_KIND.COMMAND, actions: resolveShellLine(intent, env).actions };
  }

  const parsed = parseQuestion(intent);
  const verb = parsed.question?.verb ?? verbIn(intent);
  if (verb === null) {
    return {
      kind: INTENT_KIND.PHRASE,
      actions: [],
      unrecognized:
        'No verb in that. Name one — deploy, merge, push, delete, publish, read, write — or type the command itself.',
    };
  }

  const subject = subjectIn(intent);
  const actions = candidatesFor(verb, subject, env);
  return {
    kind: INTENT_KIND.PHRASE,
    actions,
    verb,
    ...(subject === null ? {} : { subject }),
  };
}

function verbIn(intent: string): QuestionVerb | null {
  for (const word of intent.toLowerCase().split(/[^a-z]+/)) {
    const parsed = parseQuestion(`can agent ${word} thing`);
    if (parsed.question !== undefined) return parsed.question.verb;
  }
  return null;
}

/** The words after the verb, minus the filler somebody types around it. */
const FILLER = new Set([
  'the',
  'a',
  'an',
  'to',
  'my',
  'our',
  'this',
  'that',
  'service',
  'app',
]);

function subjectIn(intent: string): string | null {
  const words = intent
    .toLowerCase()
    .split(/[^a-z0-9._-]+/)
    .filter((word) => word !== '');
  const at = words.findIndex(
    (word) => parseQuestion(`can agent ${word} thing`).question !== undefined,
  );
  const rest = (at === -1 ? words : words.slice(at + 1)).filter(
    (word) => !FILLER.has(word),
  );
  return rest[0] ?? null;
}

/**
 * Every action in every verb table this intent could mean. More than one on purpose:
 * "deploy payments" is `railway deploy`, `vercel deploy --prod` and `kubectl apply`
 * until somebody says which, and answering about only the first would be a guess.
 */
function candidatesFor(
  verb: QuestionVerb,
  subject: string | null,
  env: NodeJS.ProcessEnv,
): ResolvedAction[] {
  const words = VERB_WORDS[verb];
  const found: ResolvedAction[] = [];
  const seen = new Set<string>();

  for (const table of VERB_TABLES) {
    for (const entry of table.verbs) {
      const argv = entry.match.split(/\s+/).filter((word) => !word.includes('*'));
      const decides = strongestWord(argv);
      if (decides === null || !words.includes(decides)) continue;
      const action = verbAction(table.name, entry);
      if (seen.has(action)) continue;
      seen.add(action);
      const resolved = resolveAction(table.name, argv, env);
      found.push({
        ...resolved,
        action,
        ...(subject === null ? {} : { target: subject }),
      });
    }
  }
  return found;
}
