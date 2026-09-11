import type { CliContext } from '../cli-context';
import { checkName, displayName, setName, type AgentNames, NAME_LIMIT } from './names';

/**
 * Asking what to call each agent, at the one moment a person is looking at them.
 *
 * Injected the way `protect` injects its domain asker, so a test names five
 * agents without a terminal and the default is the only thing that touches
 * stdin. Nothing here fails a discovery: naming is a convenience, and a scan
 * that refused to finish because a name was rejected would be a scan people
 * learn to run with a flag.
 */

export interface NameQuestion {
  /** What it is called now, and what pressing Enter keeps. */
  shown: string;
  /**
   * Context printed above the prompt, given by the caller rather than built here.
   *
   * The guided run has already put the agent's name and reach on screen by the
   * time it asks; the bulk pass over a discovery has not. A prompt that always
   * printed the name printed it twice in the one flow that matters most.
   */
  lines: readonly string[];
  /** Why it is being asked, which differs between finding one and enrolling one. */
  because: string;
}

/** The question, asked wherever the caller says. `null` means keep the default. */
export type NameAsker = (question: NameQuestion) => Promise<string | null>;

export const askOnTerminal: NameAsker = async ({ shown, lines, because }) => {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const above = lines.map((line) => `  ${line}\n`).join('');
  try {
    const answer = await rl.question(
      `\n${above}  ${because}, or press Enter to keep "${shown}"  > `,
    );
    const wanted = answer.trim();
    return wanted === '' ? null : wanted;
  } catch {
    /* Ctrl+D, or a stdin that closed under us. Both mean no answer, and a scan
       that threw here would be one somebody lost because they declined to name
       something. */
    return null;
  } finally {
    rl.close();
  }
};

interface Named {
  agentId: string;
  from: string;
  to: string;
}

/**
 * Walks the agents that were found and writes whatever names come back.
 *
 * Re-read between answers rather than batched at the end, because the clash
 * check has to see the name given two questions ago. Batching would let
 * somebody call two agents "Backend" and only find out at the write.
 */
export async function askForNames<T extends { id: string; kind: string }>(
  context: CliContext,
  home: string,
  agents: readonly T[],
  names: AgentNames,
  detailOf: (agent: T) => string,
  ask: NameAsker,
): Promise<Named[]> {
  const { out, style } = context;
  if (agents.length === 0) return [];

  out.line('');
  out.line(style.bold('WHAT DO YOU WANT TO CALL THEM'));
  out.line(
    style.dim(
      `  Memnox prints the name you choose everywhere afterwards. Up to ${NAME_LIMIT} characters.`,
    ),
  );

  const given: Named[] = [];
  let taken = names;
  for (const agent of agents) {
    const before = displayName(taken, agent);
    /* A failing asker keeps the default rather than taking the scan down with
       it: everything above this point is already on screen and worth keeping. */
    const wanted = await ask({
      shown: before,
      lines: [before, detailOf(agent)],
      because: 'Name it',
    }).catch(() => null);
    if (wanted === null) continue;

    const checked = checkName(wanted, agent.id, taken);
    if (!checked.ok) {
      /* Said and skipped rather than asked again. A loop here is a scan that
         cannot be finished by pressing Enter, and `memnox agents name` is one
         command away. */
      out.note(
        style.warn(`  Kept "${before}": ${checked.because ?? 'that name was refused'}`),
      );
      continue;
    }
    const written = await setName(home, agent.id, wanted);
    if (!written.ok || written.name === undefined) continue;
    taken = { ...taken, [agent.id]: written.name };
    given.push({ agentId: agent.id, from: before, to: written.name });
  }
  return given;
}

/**
 * One name, asked once, at the moment it becomes an identity somewhere else.
 *
 * Separate from `askForNames` because the question is a different one. There it
 * is a convenience over a list somebody is reading; here the answer is what a
 * workspace will call this agent from now on, and a person choosing deserves to
 * be told that before they press Enter.
 *
 * A refused name keeps the current one rather than asking again. The enrolment
 * behind this waits on a person in a browser, and a prompt loop in front of it
 * is where somebody gives up on onboarding entirely.
 */
export async function askForOneName(
  home: string,
  agent: { id: string; kind: string },
  names: AgentNames,
  because: string,
  lines: readonly string[],
  ask: NameAsker,
): Promise<{ name: string; because?: string }> {
  const before = displayName(names, agent);
  const wanted = await ask({ shown: before, lines, because }).catch(() => null);
  if (wanted === null) return { name: before };

  const checked = checkName(wanted, agent.id, names);
  if (!checked.ok) return { name: before, because: checked.because };

  const written = await setName(home, agent.id, wanted);
  if (!written.ok || written.name === undefined) {
    return { name: before, because: written.because };
  }
  return { name: written.name };
}

/**
 * `--name claude-code="Backend Coder"`, for anything that is not a person at a
 * terminal. One flag rather than a prompt, so a setup script can name a fleet.
 */
export function parseNameFlag(raw: string): { query: string; name: string } | null {
  const at = raw.indexOf('=');
  if (at <= 0) return null;
  const query = raw.slice(0, at).trim();
  const name = raw.slice(at + 1).trim();
  if (query === '' || name === '') return null;
  return { query, name };
}
