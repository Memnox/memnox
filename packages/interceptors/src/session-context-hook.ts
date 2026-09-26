/**
 * Memnox inside the session: the boundary said once when a session starts, and a decision
 * somebody already took said where the agent is about to meet it, each at most once a session.
 * Read from the rule files on disk; nothing here calls a network or consults a model.
 */
import {
  ACTION,
  boundaryContext,
  describeFact,
  factsAbout,
  MOST_FACTS_PER_CALL,
  MOST_PROMPT_WORDS,
  readWorkspaceMemory,
  decisionsCovering,
  decisionsMentioned,
  describeDecision,
  ENFORCEMENT_MODE,
  markShown,
  MOST_DECISIONS_PER_CALL,
  notYetShown,
  pruneSessionFiles,
  readProtectionStop,
  rulesHere,
  SessionContextStore,
  stopHasEnded,
  type DecisionFound,
  type DecisionSubject,
  type FactQuery,
  type ProtectionStop,
} from '@memnox/core';

import { containmentFor } from './containment-loader';
import { EDIT_HOOK_EVENT } from './edit-hook';
import { readHookConfig } from './hook-config';
import { cwdOf, fieldsOf, sessionOf } from './hook-payload';
import { repositoryRootOf } from './seam-runtime';
import { readMachineMode } from './tool-hook';

/** Who and where, as the hook process reads it once where it starts. */
export interface SessionContextDeps {
  home: string;
  agent: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  now: () => Date;
  /** Injected so a test states the repository rather than asking git. */
  rootOf?: (cwd: string) => string | null;
}

/** A session that just began, where the host sends one. */
interface SessionStart {
  sessionId: string;
  cwd?: string;
}

/** Where a decision is being looked for: one tool call's actions, or a person's words. */
interface DecisionLookup {
  sessionId: string;
  cwd?: string;
  subjects?: readonly DecisionSubject[];
  prompt?: string;
}

/** Claude Code, Codex and Gemini CLI all name it `SessionStart`, with the same reply. */
export function sessionStartOf(payload: unknown): SessionStart | null {
  const hook = fieldsOf(payload);
  if (hook === null || hook['hook_event_name'] !== EDIT_HOOK_EVENT.SESSION_START)
    return null;
  const cwd = cwdOf(hook);
  return { sessionId: sessionOf(hook), ...(cwd === undefined ? {} : { cwd }) };
}

/** The boundary as added context, or empty where Memnox is off and has nothing to say. */
export async function answerSessionStart(
  start: SessionStart,
  deps: SessionContextDeps,
): Promise<string> {
  // A session start is rare and unhurried, which makes it the place for the sweep.
  await pruneSessionFiles(deps.home, deps.now()).catch(() => 0);
  const stop = await readProtectionStop(deps.home);
  // Said rather than silent, so an agent and its person know nothing is being checked.
  if (stop !== null && !stopHasEnded(stop, deps.now())) {
    return `${addedContext(EDIT_HOOK_EVENT.SESSION_START, stoppedLine(stop))}\n`;
  }
  const mode = await readMachineMode(deps.home);
  if (mode === ENFORCEMENT_MODE.OFF) return '';
  const cwd = start.cwd ?? deps.cwd;
  const containment = await containmentFor({
    home: deps.home,
    env: deps.env,
    cwd,
    now: deps.now(),
    agent: deps.agent,
    ...(deps.rootOf === undefined ? {} : { rootOf: deps.rootOf }),
  });
  const root = containment === null ? undefined : containment.root;
  const { rules } = await rulesFor(deps, root);
  const text = [
    boundaryContext({ mode, rules, containment }),
    await memoryLine(deps.home),
  ]
    .filter((each) => each !== '')
    .join('\n');
  return text === '' ? '' : `${addedContext(EDIT_HOOK_EVENT.SESSION_START, text)}\n`;
}

/** Said once a session, so an agent knows to ask what was settled before it plans a change. */
async function memoryLine(home: string): Promise<string> {
  const memory = await readWorkspaceMemory(home).catch(() => null);
  if (memory === null || memory.facts.length === 0) return '';
  return `Your workspace has settled ${memory.facts.length} decision(s), policies and owners. Before you change code, ask the memnox-session "brief" tool about the paths, or "memory" about the subject, and cite what it says.`;
}

/**
 * The decisions this call or prompt meets that the session has not been told, a few at
 * most, marked told. Null where there is nothing new to say.
 */
export async function decisionsAt(
  lookup: DecisionLookup,
  deps: SessionContextDeps,
): Promise<string | null> {
  const rules = await ruleLines(lookup, deps);
  const facts = await factLines(lookup, deps);
  if (rules.length === 0 && facts.length === 0) return null;

  const store = new SessionContextStore(deps.home);
  const state = await store.read(lookup.sessionId);
  const fresh = [
    ...notYetShown(state, rules.map(idOf)).slice(0, MOST_DECISIONS_PER_CALL),
    ...notYetShown(state, facts.map(idOf)).slice(0, MOST_FACTS_PER_CALL),
  ];
  if (fresh.length === 0) return null;
  await store.write(lookup.sessionId, markShown(state, fresh, deps.now().toISOString()));
  return [...rules, ...facts]
    .filter((each) => fresh.includes(each.id))
    .map((each) => each.text)
    .join('\n');
}

/** One thing to say, under the id a session remembers having said it by. */
interface Line {
  id: string;
  text: string;
}

function idOf(line: Line): string {
  return line.id;
}

/** The rules a prompt names or a call meets, one line each. */
async function ruleLines(
  lookup: DecisionLookup,
  deps: SessionContextDeps,
): Promise<Line[]> {
  const root = (deps.rootOf ?? repositoryRootOf)(lookup.cwd ?? deps.cwd) ?? undefined;
  const { decisions } = await rulesFor(deps, root);
  const found =
    lookup.prompt !== undefined
      ? decisionsMentioned(decisions, lookup.prompt)
      : (lookup.subjects ?? []).flatMap((each) => decisionsCovering(decisions, each));
  return firstOfEach(found).map((each) => ({
    id: each.decision.id,
    text: describeDecision(each),
  }));
}

/** Only a change is worth a brief: an agent reading a file has not decided anything yet. */
const CHANGES: readonly string[] = [ACTION.FILESYSTEM_WRITE, ACTION.FILESYSTEM_DELETE];

/** Prefixed, so a fact and a rule can never be taken for each other in the session's record. */
const FACT_ID_PREFIX = 'fact:';

/**
 * What the workspace settled about the words of a prompt, or about the paths a write is
 * about to change. Read from the memory this machine last pulled, with no network near it.
 */
async function factLines(
  lookup: DecisionLookup,
  deps: SessionContextDeps,
): Promise<Line[]> {
  const memory = await readWorkspaceMemory(deps.home).catch(() => null);
  if (memory === null) return [];
  const query = factQueryOf(lookup);
  if (query === null) return [];
  return factsAbout(memory, query).map((found) => ({
    id: `${FACT_ID_PREFIX}${found.fact.id}`,
    text: describeFact(found),
  }));
}

/** Context beside a tool call that goes ahead, in Claude Code's words; the prompt still runs. */
export function preToolContext(text: string): string {
  return addedContext(EDIT_HOOK_EVENT.PRE_TOOL_USE, text);
}

function addedContext(hookEventName: string, text: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName, additionalContext: text },
  });
}

async function rulesFor(
  deps: SessionContextDeps,
  root: string | undefined,
): ReturnType<typeof rulesHere> {
  const config = await readHookConfig(deps.env, deps.home);
  return rulesHere({
    home: deps.home,
    policyFiles: config.policyFiles,
    agent: deps.agent,
    ...(root === undefined ? {} : { root }),
  });
}

/** One sentence per decision, however many of its actions or words it matched. */
function firstOfEach(found: readonly DecisionFound[]): DecisionFound[] {
  const seen = new Set<string>();
  return found.filter((each) => {
    if (seen.has(each.decision.id)) return false;
    seen.add(each.decision.id);
    return true;
  });
}

/** Who stopped Memnox here, until when, and the one command that brings it back. */
function stoppedLine(stop: ProtectionStop): string {
  const until = stop.until === undefined ? '' : ` until ${stop.until}`;
  const why = stop.reason === undefined ? '' : ` (${stop.reason})`;
  return `Memnox: protection on this machine is stopped${until} by ${stop.by}${why}, so nothing is checked. "memnox start" turns it back on.`;
}

/** A prompt's words, bounded like the rule lookup's, or the paths a change is about to touch. */
function factQueryOf(lookup: DecisionLookup): FactQuery | null {
  if (lookup.prompt !== undefined) {
    const words = lookup.prompt.split(/\s+/).slice(0, MOST_PROMPT_WORDS);
    return { words, paths: words.filter((word) => word.includes('/')) };
  }
  const paths = (lookup.subjects ?? []).flatMap((each) =>
    CHANGES.includes(each.action) && each.target !== undefined ? [each.target] : [],
  );
  return paths.length > 0 ? { paths } : null;
}
