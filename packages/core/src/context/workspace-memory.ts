/**
 * What the workspace has settled, as this machine last pulled it, and the lookup that finds
 * the part a prompt or a path is about. The control plane hands over the whole set and never
 * ranks it, so the choosing happens here, by shared words, with every match naming its words.
 */

/** One settled thing, as the control plane's `GET :ws/memory` sends it. */
export interface WorkspaceFact {
  id: string;
  /** decision, policy, authority, responsibility or relationship. */
  kind: string;
  statement: string;
  subject: string;
  scope?: string;
  /** The person it names: the owner, the approver, the party. */
  principal?: string;
  capability?: string;
  object?: string;
  sourceRef?: string;
  /** declared, authoritative or observed. */
  provenance?: string;
  /** Who confirmed it. */
  verifiedBy?: string;
  settledAt?: string;
}

export interface WorkspaceMemory {
  hash: string;
  facts: WorkspaceFact[];
  /** How many facts this machine is not cleared for, so a partial set is never read as whole. */
  withheld: number;
  /** When this machine last heard from the control plane about it. */
  syncedAt: string;
}

/** What is being looked up: words a person typed, and paths an agent is about to touch. */
export interface FactQuery {
  words?: readonly string[];
  paths?: readonly string[];
}

/** A match, with the words it matched on, so why it was said is never a mystery. */
export interface FactFound {
  fact: WorkspaceFact;
  matched: string[];
  /** True when it matched on what the fact is about rather than only on its wording. */
  onSubject: boolean;
}

/** The order a brief reads in: what was chosen, then the rules, then who. */
const KIND_ORDER: readonly string[] = [
  'decision',
  'policy',
  'authority',
  'responsibility',
  'relationship',
];

/** Words that say nothing about what a fact is about. */
const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    'the and for with that this from into onto what when where which who whom why how ' +
    'can could should would will must may might not you your our are was were been being ' +
    'have has had does did doing done make made use used using get got let fix add new old ' +
    'please want need like just also then than them they there here its about over under ' +
    'all any some each every only more most very file files code thing things work working'
  ).split(' '),
);

/** Directory and file names that name no part of a system. */
const GENERIC_SEGMENTS: ReadonlySet<string> = new Set(
  (
    'src lib app apps packages package test tests spec index main dist build internal pkg ' +
    'cmd components component utils util common shared core ts tsx js jsx mjs cjs py go rb ' +
    'rs java kt json yaml yml toml md'
  ).split(' '),
);

const SHORTEST_TERM = 3;

/** Two words of a statement, since one shared word is how everything matches everything. */
const WORDING_MATCHES_NEEDED = 2;

/** The facts a query is about, those matched on their subject first. */
export function factsAbout(memory: WorkspaceMemory, query: FactQuery): FactFound[] {
  const terms = queryTerms(query);
  const paths = (query.paths ?? []).map(normalPath);
  if (terms.size === 0 && paths.length === 0) return [];
  return memory.facts
    .map((fact) => matchOf(fact, terms, paths))
    .filter((found): found is FactFound => found !== null)
    .sort(byStrength);
}

/** The newest facts, for a lookup that named nothing in particular. */
export function newestFacts(memory: WorkspaceMemory, most: number): WorkspaceFact[] {
  return [...memory.facts]
    .sort((a, b) => (b.settledAt ?? '').localeCompare(a.settledAt ?? ''))
    .slice(0, most);
}

/** One sentence an agent can cite: what was settled, who settled it, when, and where. */
export function describeFact(found: FactFound): string {
  const { fact } = found;
  return `Your workspace settled this about ${fact.subject}: "${fact.statement}" (${factOrigin(fact)}).`;
}

/** Who confirmed it, when, and where it came from, in the words a person reads. */
export function factOrigin(fact: WorkspaceFact): string {
  const parts = [KIND_WORDS[fact.kind] ?? fact.kind];
  if (fact.verifiedBy !== undefined) parts.push(`confirmed by ${fact.verifiedBy}`);
  else if (fact.provenance !== undefined)
    parts.push(PROVENANCE_WORDS[fact.provenance] ?? fact.provenance);
  if (fact.settledAt !== undefined) parts.push(`on ${fact.settledAt.slice(0, 10)}`);
  if (fact.sourceRef !== undefined) parts.push(`source ${fact.sourceRef}`);
  return parts.join(', ');
}

const KIND_WORDS: Readonly<Record<string, string>> = {
  decision: 'a decision',
  policy: 'a policy',
  authority: 'an approval authority',
  responsibility: 'an ownership',
  relationship: 'a relationship',
};

const PROVENANCE_WORDS: Readonly<Record<string, string>> = {
  declared: 'written down by a person',
  authoritative: 'from a system of record',
  observed: 'read from a conversation',
};

/**
 * The shape the control plane sends, checked field by field, or null where it is not one.
 * A fact missing its id, statement or subject is dropped rather than guessed at.
 */
export function parseWorkspaceMemory(
  value: unknown,
  syncedAt: string,
): WorkspaceMemory | null {
  if (value === null || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  if (typeof body['hash'] !== 'string' || !Array.isArray(body['facts'])) return null;
  const facts = body['facts'].map(factOf).filter((f): f is WorkspaceFact => f !== null);
  const withheld = typeof body['withheld'] === 'number' ? body['withheld'] : 0;
  return { hash: body['hash'], facts, withheld, syncedAt };
}

const OPTIONAL_TEXT = [
  'scope',
  'principal',
  'capability',
  'object',
  'sourceRef',
  'provenance',
  'verifiedBy',
  'settledAt',
] as const;

function factOf(value: unknown): WorkspaceFact | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const { id, kind, statement, subject } = raw;
  if (
    typeof id !== 'string' ||
    typeof kind !== 'string' ||
    typeof statement !== 'string' ||
    typeof subject !== 'string'
  ) {
    return null;
  }
  const fact: WorkspaceFact = { id, kind, statement, subject };
  for (const key of OPTIONAL_TEXT) {
    const field = raw[key];
    if (typeof field === 'string' && field !== '') fact[key] = field;
  }
  return fact;
}

function matchOf(
  fact: WorkspaceFact,
  terms: ReadonlySet<string>,
  paths: readonly string[],
): FactFound | null {
  const scoped = scopeCovers(fact, paths);
  const onSubject = [...termsOf(subjectText(fact))].filter((term) => terms.has(term));
  if (scoped !== null || onSubject.length > 0) {
    return {
      fact,
      matched: scoped === null ? onSubject : [scoped, ...onSubject],
      onSubject: true,
    };
  }
  const worded = [...termsOf(fact.statement)].filter((term) => terms.has(term));
  if (worded.length < WORDING_MATCHES_NEEDED) return null;
  return { fact, matched: worded, onSubject: false };
}

/** What a fact is about, as opposed to how it is worded. */
function subjectText(fact: WorkspaceFact): string {
  // A scope written as a path is matched on its segments, never word by word.
  const scope = fact.scope?.includes('/') === true ? undefined : fact.scope;
  return [fact.subject, scope, fact.capability, fact.object].filter(Boolean).join(' ');
}

/** A scope written as a path covers every path under it, on segment boundaries. */
function scopeCovers(fact: WorkspaceFact, paths: readonly string[]): string | null {
  if (fact.scope === undefined || !fact.scope.includes('/')) return null;
  const scope = normalPath(fact.scope);
  const covered = paths.some(
    (path) =>
      path === scope ||
      path.startsWith(`${scope}/`) ||
      path.includes(`/${scope}/`) ||
      path.endsWith(`/${scope}`),
  );
  return covered ? fact.scope : null;
}

function byStrength(a: FactFound, b: FactFound): number {
  if (a.onSubject !== b.onSubject) return a.onSubject ? -1 : 1;
  if (a.matched.length !== b.matched.length) return b.matched.length - a.matched.length;
  const kinds = kindRank(a.fact.kind) - kindRank(b.fact.kind);
  return kinds !== 0 ? kinds : a.fact.id.localeCompare(b.fact.id);
}

function kindRank(kind: string): number {
  const at = KIND_ORDER.indexOf(kind);
  return at === -1 ? KIND_ORDER.length : at;
}

function queryTerms(query: FactQuery): Set<string> {
  const terms = new Set<string>();
  for (const word of query.words ?? []) for (const term of termsOf(word)) terms.add(term);
  for (const path of query.paths ?? [])
    for (const term of pathTerms(path)) terms.add(term);
  return terms;
}

/** A path's parts that name something: `src/payments/retry.ts` is payments and retry. */
function pathTerms(path: string): Set<string> {
  const parts = normalPath(path)
    .split('/')
    .flatMap((part) => part.split('.'));
  const named = parts.filter((part) => !GENERIC_SEGMENTS.has(part.toLowerCase()));
  return termsOf(named.join(' '));
}

/** Lowercased words, camel case split, stop words and short words dropped, plurals folded. */
export function termsOf(text: string): Set<string> {
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return new Set(
    words
      .filter((word) => word.length >= SHORTEST_TERM && !STOP_WORDS.has(word))
      .map(singular),
  );
}

/** Folded the same way on both sides, so it only has to be consistent, not correct. */
function singular(word: string): string {
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3)
    return word.slice(0, -1);
  return word;
}

function normalPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}
