/**
 * A grammar, not a model. The question a person types is matched against a fixed
 * shape and a fixed synonym table; anything it does not recognise is refused with
 * the shape it wanted. A model reading this sentence would be a model in the path of
 * an answer about authority, which is the one place it must never be.
 */

export const QUESTION_VERB = {
  READ: 'read',
  WRITE: 'write',
  DELETE: 'delete',
  DEPLOY: 'deploy',
  MERGE: 'merge',
  PUSH: 'push',
  SEND: 'send',
} as const;

export type QuestionVerb = (typeof QUESTION_VERB)[keyof typeof QUESTION_VERB];

/** Every word that means one of the seven verbs. A word absent here is not guessed. */
const SYNONYMS: Readonly<Record<string, QuestionVerb>> = {
  read: QUESTION_VERB.READ,
  reads: QUESTION_VERB.READ,
  see: QUESTION_VERB.READ,
  view: QUESTION_VERB.READ,
  open: QUESTION_VERB.READ,
  access: QUESTION_VERB.READ,
  get: QUESTION_VERB.READ,
  list: QUESTION_VERB.READ,

  write: QUESTION_VERB.WRITE,
  writes: QUESTION_VERB.WRITE,
  edit: QUESTION_VERB.WRITE,
  modify: QUESTION_VERB.WRITE,
  change: QUESTION_VERB.WRITE,
  update: QUESTION_VERB.WRITE,
  create: QUESTION_VERB.WRITE,

  delete: QUESTION_VERB.DELETE,
  deletes: QUESTION_VERB.DELETE,
  drop: QUESTION_VERB.DELETE,
  destroy: QUESTION_VERB.DELETE,
  remove: QUESTION_VERB.DELETE,
  truncate: QUESTION_VERB.DELETE,

  deploy: QUESTION_VERB.DEPLOY,
  deploys: QUESTION_VERB.DEPLOY,
  release: QUESTION_VERB.DEPLOY,
  ship: QUESTION_VERB.DEPLOY,

  merge: QUESTION_VERB.MERGE,
  merges: QUESTION_VERB.MERGE,

  push: QUESTION_VERB.PUSH,
  pushes: QUESTION_VERB.PUSH,

  send: QUESTION_VERB.SEND,
  sends: QUESTION_VERB.SEND,
  email: QUESTION_VERB.SEND,
  message: QUESTION_VERB.SEND,
  post: QUESTION_VERB.SEND,
  notify: QUESTION_VERB.SEND,
};

/** Words that carry no meaning here and are dropped before matching. */
const FILLER = new Set([
  'can',
  'could',
  'may',
  'is',
  'able',
  'to',
  'the',
  'a',
  'an',
  'my',
  'our',
  'from',
  'in',
  'on',
  'at',
  'into',
  'right',
  'now',
  'currently',
  'allowed',
]);

export interface ParsedQuestion {
  agent: string;
  verb: QuestionVerb;
  resource: string;
}

export interface QuestionParse {
  question?: ParsedQuestion;
  /** What to type instead. Never a guess at what was meant. */
  error?: string;
}

export const QUESTION_SHAPE = 'can <agent> <verb> <resource>';

/** The seven verbs, for a usage line that names them rather than describing them. */
export function questionVerbs(): readonly QuestionVerb[] {
  return Object.values(QUESTION_VERB);
}

function usage(problem: string): QuestionParse {
  return {
    error:
      `${problem}\n` +
      `Ask it in this shape:  ${QUESTION_SHAPE}\n` +
      `Verbs: ${questionVerbs().join(', ')}\n` +
      `For example:  memnox explain "can claude read ~/.aws"`,
  };
}

export function parseQuestion(raw: string): QuestionParse {
  const words = raw
    .replace(/[?"']/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word !== '');

  if (words.length === 0) return usage('There is no question there.');

  const kept = words.filter((word) => !FILLER.has(word.toLowerCase()));
  const verbAt = kept.findIndex((word) => SYNONYMS[word.toLowerCase()] !== undefined);

  if (verbAt === -1) {
    return usage(
      `No verb in "${raw.trim()}" is one this can answer, so it will not guess at one.`,
    );
  }

  const agent = kept.slice(0, verbAt).join(' ');
  const resource = kept.slice(verbAt + 1).join(' ');

  if (agent === '') return usage('Name the agent the question is about.');
  if (resource === '') return usage('Name what the agent would be acting on.');

  return {
    question: {
      agent,
      verb: SYNONYMS[kept[verbAt]?.toLowerCase() ?? ''] as QuestionVerb,
      resource,
    },
  };
}

/** The action namespace a verb maps onto, so a question meets the same rules a call does. */
export function actionForVerb(verb: QuestionVerb): string {
  const namespaces: Record<QuestionVerb, string> = {
    [QUESTION_VERB.READ]: 'filesystem.read',
    [QUESTION_VERB.WRITE]: 'filesystem.write',
    [QUESTION_VERB.DELETE]: 'filesystem.delete',
    [QUESTION_VERB.DEPLOY]: 'deploy.service',
    [QUESTION_VERB.MERGE]: 'git.merge',
    [QUESTION_VERB.PUSH]: 'git.push',
    [QUESTION_VERB.SEND]: 'message.send',
  };
  return namespaces[verb];
}
