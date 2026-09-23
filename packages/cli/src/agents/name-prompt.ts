import type { CliContext } from '../cli-context';
import { checkName, displayName, setName, type AgentNames, NAME_LIMIT } from './names';

/**
 * Asking what to call each agent, at the moment a person is looking at them. Nothing
 * here fails a discovery, because naming is a convenience.
 */

export interface NameQuestion {
  /** What it is called now, and what pressing Enter keeps. */
  shown: string;
  /** Context printed above the prompt, given by the caller, which knows what is already on screen. */
  lines: readonly string[];
  /** Why it is being asked, which differs between finding one and enrolling one. */
  because: string;
  /** What every line starts with, so a prompt sits on a rail: readline takes a gutter, not a renderer. */
  gutter?: string;
}

/** The question, asked wherever the caller says. `null` means keep the default. */
export type NameAsker = (question: NameQuestion) => Promise<string | null>;

export async function askOnTerminal({
  shown,
  lines,
  because,
  gutter,
}: NameQuestion): Promise<string | null> {
  const { createInterface } = await import('node:readline/promises');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const lead = gutter ?? '  ';
  const above = lines.map((line) => `${lead}${line}\n`).join('');
  try {
    const answer = await prompt.question(
      `\n${above}${lead}${because}, or press Enter to keep "${shown}"  > `,
    );
    const wanted = answer.trim();
    return wanted === '' ? null : wanted;
  } catch {
    // Ctrl+D, or a stdin that closed under us: both mean no answer, never a lost scan.
    return null;
  } finally {
    prompt.close();
  }
}

interface Named {
  agentId: string;
  from: string;
  to: string;
}

export interface AskForNamesInput<T extends { id: string; kind: string }> {
  context: CliContext;
  home: string;
  agents: readonly T[];
  names: AgentNames;
  detailOf: (agent: T) => string;
  ask: NameAsker;
}

/**
 * Walks the agents that were found and writes whatever names come back, re-reading
 * between answers because the clash check has to see the name given a question ago.
 */
export async function askForNames<T extends { id: string; kind: string }>(
  input: AskForNamesInput<T>,
): Promise<Named[]> {
  const { flow } = input.context;
  if (input.agents.length === 0) return [];

  flow.step(
    'What do you want to call them',
    `Memnox prints the name you choose everywhere afterwards. Up to ${NAME_LIMIT} characters.`,
  );

  const given: Named[] = [];
  let taken = input.names;
  for (const agent of input.agents) {
    const named = await askForAgentName(input, agent, taken);
    if (named === null) continue;
    taken = { ...taken, [agent.id]: named.to };
    given.push(named);
  }
  return given;
}

/** One agent of the walk, or null where the default was kept. */
async function askForAgentName<T extends { id: string; kind: string }>(
  input: AskForNamesInput<T>,
  agent: T,
  taken: AgentNames,
): Promise<Named | null> {
  const { flow, style } = input.context;
  const before = displayName(taken, agent);
  // A failing asker keeps the default rather than taking the scan down with it.
  const wanted = await input
    .ask({
      shown: before,
      lines: [before, input.detailOf(agent)],
      gutter: flow.prompt,
      because: 'Name it',
    })
    .catch(() => null);
  if (wanted === null) return null;

  const checked = checkName(wanted, agent.id, taken);
  if (!checked.ok) {
    // Said and skipped rather than asked again, so Enter always finishes the scan.
    flow.aside(
      style.warn(`Kept "${before}": ${checked.because ?? 'that name was refused'}`),
    );
    return null;
  }
  const written = await setName(input.home, agent.id, wanted);
  if (!written.ok || written.name === undefined) return null;
  return { agentId: agent.id, from: before, to: written.name };
}

export interface AskForOneNameInput {
  home: string;
  agent: { id: string; kind: string };
  names: AgentNames;
  because: string;
  lines: readonly string[];
  ask: NameAsker;
}

/**
 * One name, asked at the moment it becomes what a workspace calls this agent. A refused
 * name keeps the current one rather than looping in front of a browser wait.
 */
export async function askForOneName(
  input: AskForOneNameInput,
): Promise<{ name: string; because?: string }> {
  const { home, agent, names, because, lines, ask } = input;
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

/** `--name claude-code="Backend Coder"`, so a setup script can name a fleet without a prompt. */
export function parseNameFlag(raw: string): { query: string; name: string } | null {
  const at = raw.indexOf('=');
  if (at <= 0) return null;
  const query = raw.slice(0, at).trim();
  const name = raw.slice(at + 1).trim();
  if (query === '' || name === '') return null;
  return { query, name };
}
