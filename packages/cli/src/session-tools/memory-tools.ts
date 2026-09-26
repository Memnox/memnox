/**
 * What the workspace has settled, asked from inside the session: `memory` looks through what
 * this machine last pulled, and `brief` asks the control plane about the paths an agent is
 * about to change. Both read and write nothing, and neither is consulted by any verdict.
 */
import {
  factOrigin,
  factsAbout,
  MOST_FACTS_ANSWERED,
  newestFacts,
  readWorkspaceMemoryCached,
  type WorkspaceFact,
  type WorkspaceMemory,
} from '@memnox/core';

import { textArg, type SessionToolDeps, type ToolArgs } from './read-tools';

const NOT_CONNECTED =
  'This machine holds no workspace memory: it is not connected to a workspace, or has not pulled one yet. "memnox login" connects it.';

/** Settled facts about the words or paths given, or the newest ones when none are. */
export async function memoryTool(
  deps: SessionToolDeps,
  args: ToolArgs,
): Promise<unknown> {
  const memory = await readWorkspaceMemoryCached(deps.home);
  if (memory === null) return { connected: false, said: NOT_CONNECTED };
  const about = textArg(args, 'about');
  if (about === undefined) {
    return answerOf(memory, newestFacts(memory, MOST_FACTS_ANSWERED), 'the newest');
  }
  const words = about.split(/[\s,]+/);
  const found = factsAbout(memory, {
    words,
    paths: words.filter((word) => word.includes('/') || /\.\w+$/.test(word)),
  });
  return answerOf(
    memory,
    found.slice(0, MOST_FACTS_ANSWERED).map((each) => each.fact),
    about,
  );
}

/**
 * The live brief for the paths given, or what this machine holds about them where the
 * control plane cannot be asked, said as such so a stale answer is never read as a fresh one.
 */
export async function briefTool(deps: SessionToolDeps, args: ToolArgs): Promise<unknown> {
  const resources = (textArg(args, 'paths') ?? '')
    .split(/[\s,]+/)
    .filter((each) => each !== '');
  if (resources.length === 0) {
    return { said: 'Name the paths, services or repository you are about to change.' };
  }
  const repository = textArg(args, 'repository');
  const live = await deps.brief(resources, repository);
  if (live !== null) return { from: 'the workspace, just now', brief: live };
  const memory = await readWorkspaceMemoryCached(deps.home);
  if (memory === null) return { connected: false, said: NOT_CONNECTED };
  const found = factsAbout(memory, { paths: resources, words: resources });
  return answerOf(
    memory,
    found.slice(0, MOST_FACTS_ANSWERED).map((each) => each.fact),
    resources.join(', '),
  );
}

function answerOf(
  memory: WorkspaceMemory,
  facts: readonly WorkspaceFact[],
  about: string,
): Record<string, unknown> {
  return {
    about,
    from: `what this machine pulled from the workspace at ${memory.syncedAt}`,
    facts: facts.map(factRow),
    ...(facts.length === 0
      ? { said: 'The workspace has settled nothing about this.' }
      : {}),
    ...(memory.withheld > 0
      ? { withheld: `${memory.withheld} fact(s) this machine is not cleared to read` }
      : {}),
    cite: 'Quote these rather than restating them, and ask a person where the task disagrees.',
  };
}

function factRow(fact: WorkspaceFact): Record<string, unknown> {
  return {
    statement: fact.statement,
    about: fact.subject,
    ...(fact.scope === undefined ? {} : { scope: fact.scope }),
    ...(fact.principal === undefined ? {} : { names: fact.principal }),
    settled: factOrigin(fact),
  };
}
