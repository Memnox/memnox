/**
 * `memnox-session`: the stdio MCP server each agent's config launches, so a person can ask
 * Memnox from inside the conversation. `--agent` names whose sessions it reads.
 */
import { closeSync, openSync } from 'node:fs';
import { homedir } from 'node:os';

import {
  AGENT_FLAG,
  Milestones,
  NodeGit,
  NodeWorktree,
  type Milestone,
} from '@memnox/core';

import { readStatus } from '../commands/status.command';
import type { SessionToolDeps } from './read-tools';
import type { RewindSeams } from './rewind-tool';
import { serveSession } from './session-server';

/** Whose sessions to read when the launch line names nobody. */
const UNNAMED_AGENT = 'unknown-agent';

/** Set by CI systems and headless agent runs, where nobody sees a prompt. */
const UNATTENDED_MARKERS: readonly string[] = [
  'CI',
  'GITHUB_ACTIONS',
  'BUILDKITE',
  'GITLAB_CI',
  'JENKINS_URL',
];

const CONTROLLING_TERMINAL = '/dev/tty';

export function agentFrom(argv: readonly string[]): string {
  const at = argv.indexOf(AGENT_FLAG);
  const named = at === -1 ? undefined : argv[at + 1];
  return named === undefined || named === '' ? UNNAMED_AGENT : named;
}

export function isUnattended(env: NodeJS.ProcessEnv): boolean {
  return UNATTENDED_MARKERS.some(
    (name) => (env[name] ?? '') !== '' && env[name] !== 'false',
  );
}

/** Whether this process shares a terminal with a person, as an agent run from a shell does. */
function hasTerminal(): boolean {
  try {
    closeSync(openSync(CONTROLLING_TERMINAL, 'r'));
    return true;
  } catch {
    // No controlling terminal: a GUI host or a detached run, which is an answer rather than a fault.
    return false;
  }
}

function milestonesIn(place: string): Milestones {
  return new Milestones(new NodeGit(place), new NodeWorktree(place));
}

async function milestonesAt(place: string): Promise<Milestone[]> {
  try {
    return await milestonesIn(place).list();
  } catch {
    // Not a repository: it simply kept no milestones.
    return [];
  }
}

function depsFor(argv: readonly string[], env: NodeJS.ProcessEnv): SessionToolDeps {
  return {
    home: homedir(),
    cwd: process.cwd(),
    agent: agentFrom(argv),
    env,
    now: () => new Date(),
    readStatus,
    milestonesAt,
  };
}

/** Serves on this process's stdio until the host closes it. */
export function runSessionServer(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const seams: Omit<RewindSeams, 'confirm'> = {
    build: milestonesIn,
    unattended: () => isUnattended(env),
    terminal: hasTerminal,
  };
  return serveSession({
    input: process.stdin,
    output: process.stdout,
    deps: depsFor(argv, env),
    seams,
  });
}
