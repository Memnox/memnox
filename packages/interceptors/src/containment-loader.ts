/**
 * The containment a seam applies, read from local state at the moment of the decision:
 * the session's repository, what `memnox run` said about it, and whether its agent is
 * still on probation. The same answer for a hooked agent and one started under `run`.
 */
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  DISCOVERED_AGENT_KIND,
  ENV_AGENT_NAME,
  PROBATION_KIND,
  ProbationRegister,
  probationOf,
  SESSION_VAR,
  SessionContainments,
  trustCommandFor,
  type Containment,
} from '@memnox/core';

import { repositoryRootOf } from './seam-runtime';
import { DEFAULT_AGENT_NAME } from './tool-hook.constants';

/** Where a write lands without asking: temp, however the platform spells it, and devices. */
const SCRATCH: readonly string[] = [
  '/tmp',
  '/private/tmp',
  '/var/folders',
  '/private/var/folders',
  '/dev',
];

/** The agent an environment marker names, for a hooked agent that sets no Memnox variable. */
const MARKER_AGENTS: Readonly<Record<string, string>> = {
  CLAUDECODE: DEFAULT_AGENT_NAME,
  CODEX_SANDBOX: DISCOVERED_AGENT_KIND.CODEX_CLI,
  CURSOR_AGENT: DISCOVERED_AGENT_KIND.CURSOR,
};

export interface ContainmentSources {
  home: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  now: Date;
  /** The agent this seam speaks for, where the caller knows better than the environment. */
  agent?: string;
  /** Globs the session's task declared. */
  paths?: readonly string[];
  /** Injected so a test states the repository rather than asking git. */
  rootOf?: (cwd: string) => string | null;
}

/** Null when there is nothing to contain: no repository, no untrusted session, no probation. */
export async function containmentFor(
  sources: ContainmentSources,
): Promise<Containment | null> {
  const { home, env, cwd, now } = sources;
  const sessionId = env[SESSION_VAR];
  const session =
    sessionId === undefined ? null : await new SessionContainments(home).read(sessionId);
  const root = session?.root ?? (sources.rootOf ?? repositoryRootOf)(cwd) ?? undefined;
  const agent =
    sources.agent ?? env[ENV_AGENT_NAME] ?? session?.agent ?? agentOfMarkers(env);
  const onProbation =
    agent === null
      ? null
      : probationOf(
          await new ProbationRegister(home).all(),
          PROBATION_KIND.AGENT,
          agent,
          now,
        );
  const untrusted =
    session?.untrusted === true || (await clonedByAnAgent(home, root ?? cwd, now));
  if (root === undefined && onProbation === null && !untrusted) return null;
  return {
    ...(root === undefined ? {} : { root }),
    ...(sources.paths === undefined ? {} : { paths: sources.paths }),
    cwd,
    home,
    scratch: scratchDirectories(),
    untrusted,
    ...(onProbation === null
      ? {}
      : {
          probation: {
            name: onProbation.label ?? onProbation.name,
            until: onProbation.until,
            trustCommand: trustCommandFor(onProbation.kind, onProbation.name),
          },
        }),
  };
}

/** A repository an agent cloned is untrusted wherever work happens inside it. */
async function clonedByAnAgent(home: string, root: string, now: Date): Promise<boolean> {
  const entries = await new ProbationRegister(home).all();
  return probationOf(entries, PROBATION_KIND.REPOSITORY, root, now) !== null;
}

function agentOfMarkers(env: NodeJS.ProcessEnv): string | null {
  const marker = Object.keys(MARKER_AGENTS).find((name) => (env[name] ?? '') !== '');
  return marker === undefined ? null : (MARKER_AGENTS[marker] ?? null);
}

/** The platform's temp as well as the usual spellings, resolved, since macOS links /tmp. */
function scratchDirectories(): string[] {
  const found = new Set(SCRATCH);
  try {
    found.add(realpathSync(tmpdir()));
  } catch {
    // A temp directory that will not resolve is left to the spellings above.
  }
  found.add(tmpdir());
  return [...found];
}
