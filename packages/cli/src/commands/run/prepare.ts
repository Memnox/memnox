/**
 * Everything `memnox run` sets up before the agent takes the terminal: the session, the
 * declared task, the milestone, the egress proxy, the containment record, and the wall.
 * Each piece is best effort except the ones an untrusted session is promised.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  DISCOVERED_AGENT_KIND,
  ENV_AGENT_NAME,
  isEmptyScope,
  MILESTONE_REASON,
  Milestones,
  SessionContainments,
  SessionTasks,
  taskFor,
  type DeclaredScope,
  type SessionTask,
  TASK_INTENT,
  ENV_PARENT_AGENTS,
  parentAgentsOf,
  SESSION_VAR,
} from '@memnox/core';
import {
  DEFAULT_AGENT_NAME,
  ENV_AGENT_ROLE,
  repositoryRootOf,
} from '@memnox/interceptors';
import { transcriptPathFor } from '../../memnox-paths';
import { NodeGit, NodeWorktree } from '../../node-git';
import { familiarityOf, untrustedHint, type Familiarity } from './familiar';
import {
  proxyEnvironment,
  sessionEgress,
  type EgressSeams,
  type SessionEgress,
} from './network';
import { sandboxed, untrustedSandbox, type GuardSeams, type Sandboxed } from './sandbox';
import { untrustedPreset } from './untrusted';

/** The seam agent a binary is, so its probation and destinations are its own. */
const AGENT_OF_BINARY: Readonly<Record<string, string>> = {
  claude: DEFAULT_AGENT_NAME,
  codex: DISCOVERED_AGENT_KIND.CODEX_CLI,
  'cursor-agent': DISCOVERED_AGENT_KIND.CURSOR,
};

/** Temp as seatbelt matches it, since `/tmp` is a link to `/private/tmp` on macOS. */
const SYSTEM_TEMPS: readonly string[] = ['/tmp', '/private/tmp'];

export interface RunDeps {
  /** Injected so a test never writes a ref into the repository it is running in. */
  milestones?: () => Milestones;
  /** Injected so a test drives the real command body without starting a process. */
  start?: (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    transcript?: string,
  ) => Promise<number>;
  home?: () => string;
  env?: NodeJS.ProcessEnv;
  newId?: () => string;
  now?: () => Date;
  /** Injected so a test states what is installed rather than reading the runner's PATH. */
  onPath?: (binary: string) => boolean;
  binaryMeantBy?: (name: string) => string | null;
  /** Injected so a test says what is installed rather than reading the runner's home. */
  interceptorsIn?: (home: string) => readonly string[];
  cwd?: () => string;
  /** Injected so a test states the repository rather than asking git. */
  rootOf?: (cwd: string) => string | null;
  familiarity?: (home: string, root: string) => Familiarity | null;
  egress?: EgressSeams;
  guard?: GuardSeams;
}

export interface RunOptions {
  shell: string;
  transcript?: boolean;
  guard?: boolean;
  milestone?: boolean;
  untrusted?: boolean;
  task?: string;
  paths?: string;
  repos?: string;
  services?: string;
  envs?: string;
  expect?: string;
  role?: string;
  investigate?: boolean;
}

/** Everything the run set up before the agent took the terminal, and what the rail says about it. */
export interface PreparedRun {
  binary: string;
  home: string;
  sessionId: string;
  agent: string;
  env: NodeJS.ProcessEnv;
  declared: SessionTask | null;
  kept: string | null;
  sandbox: Sandboxed;
  egress: SessionEgress | null;
  untrusted: boolean;
  /** The one line suggesting `--untrusted`, where the repository is new here. */
  hint: string | null;
  transcript: string | undefined;
}

/** The base environment before the proxy: a function so run.command keeps its tested seam. */
type EnvironmentFor = (home: string, sessionId: string) => NodeJS.ProcessEnv;

interface PrepareRunInput {
  binary: string;
  command: readonly string[];
  options: RunOptions;
  deps: RunDeps;
  environment: EnvironmentFor;
}

export async function prepareRun(input: PrepareRunInput): Promise<PreparedRun> {
  const base = startingPoint(input);
  const { home, sessionId, agent, env } = base;
  const untrusted = input.options.untrusted === true;
  const egress = await egressFor({ home, sessionId, agent, untrusted, deps: input.deps });
  if (egress !== null) Object.assign(env, proxyEnvironment(egress.url));
  try {
    return { ...base, ...(await settle(input, base, egress)), egress, untrusted };
  } catch (err) {
    // A session's own proxy keeps this process alive, so a run that will not start closes it.
    await egress?.close();
    throw err;
  }
}

/** What the run knows before anything is started: who, where, and whether the place is new. */
interface StartingPoint {
  binary: string;
  home: string;
  sessionId: string;
  agent: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  root: string | null;
  hint: string | null;
}

function startingPoint(input: PrepareRunInput): StartingPoint {
  const { binary, options, deps } = input;
  const home = (deps.home ?? homedir)();
  const sessionId = (deps.newId ?? newSessionId)();
  const cwd = (deps.cwd ?? process.cwd)();
  const root = (deps.rootOf ?? repositoryRootOf)(cwd);
  // Asked before anything in this run remembers the repository, or it would vouch for itself.
  const hint =
    options.untrusted === true || root === null
      ? null
      : untrustedHint((deps.familiarity ?? familiarityOf)(home, root));
  const env = input.environment(home, sessionId);
  if (options.role !== undefined) env[ENV_AGENT_ROLE] = options.role;
  const agent = agentOfRun(env, binary);
  // Every seam the agent's children reach reads this, so none of them reports it anonymous.
  env[ENV_AGENT_NAME] = agent;
  const parents = parentsOfRun(agent);
  if (parents.length > 0) env[ENV_PARENT_AGENTS] = parents.join(',');
  return { binary, home, sessionId, agent, env, cwd, root, hint };
}

/**
 * The agent this run starts. Inside another run the inherited name is the parent's, so the
 * child is named by its own binary; outside one, a name somebody set is kept.
 */
function agentOfRun(env: NodeJS.ProcessEnv, binary: string): string {
  const own = AGENT_OF_BINARY[basename(binary)] ?? basename(binary);
  if (process.env[SESSION_VAR] !== undefined) return own;
  return env[ENV_AGENT_NAME] ?? own;
}

/** The agents above this run: the chain it inherited, and the run or agent it was started in. */
function parentsOfRun(agent: string): string[] {
  const outer =
    process.env[SESSION_VAR] === undefined ? undefined : process.env[ENV_AGENT_NAME];
  const above = parentAgentsOf(process.env, agent);
  const chain = outer === undefined ? above : [...above, outer];
  return [...new Set(chain)].filter((each) => each !== agent);
}

/** The records and the wall, set once the proxy is known. */
async function settle(
  input: PrepareRunInput,
  base: StartingPoint,
  egress: SessionEgress | null,
): Promise<Pick<PreparedRun, 'declared' | 'kept' | 'sandbox' | 'transcript'>> {
  const { options, deps } = input;
  const { home, sessionId, agent, root, env } = base;
  const untrusted = options.untrusted === true;
  // Declared before the agent starts, because every drift check compares against it.
  const declared = await declareTask(home, sessionId, options, deps);
  await declareContainment({ home, sessionId, agent, root, untrusted, deps });
  // Kept before a single command runs, so the way back already exists when it is needed.
  const kept =
    options.milestone === false
      ? null
      : await keepMilestone(sessionId, base.binary, deps);
  const workspace = root ?? base.cwd;
  const sandbox = wallFor({ input, home, sessionId, workspace, egress, env });
  const transcript =
    options.transcript === true ? transcriptPathFor(home, sessionId) : undefined;
  return { declared, kept, sandbox, transcript };
}

function newSessionId(): string {
  return `ses_${randomUUID().slice(0, 12)}`;
}

interface EgressInput {
  home: string;
  sessionId: string;
  agent: string;
  untrusted: boolean;
  deps: RunDeps;
}

/** Null where no proxy could be had, which an ordinary run survives and an untrusted one does not. */
async function egressFor(input: EgressInput): Promise<SessionEgress | null> {
  const { home, sessionId, agent, untrusted, deps } = input;
  try {
    return await sessionEgress({
      home,
      caller: { sessionId, agent },
      untrusted,
      ...(deps.egress === undefined ? {} : { seams: deps.egress }),
    });
  } catch (err) {
    if (untrusted)
      throw new Error(
        `An untrusted session needs its egress proxy, and it would not start: ${String(err)}`,
      );
    return null;
  }
}

interface ContainmentInput {
  home: string;
  sessionId: string;
  agent: string;
  root: string | null;
  untrusted: boolean;
  deps: RunDeps;
}

/** Written for the seams, which are other processes; only an untrusted one must not be lost. */
async function declareContainment(input: ContainmentInput): Promise<void> {
  const { home, sessionId, agent, root, untrusted, deps } = input;
  try {
    await new SessionContainments(home).declare({
      sessionId,
      agent,
      ...(root === null ? {} : { root }),
      untrusted,
      startedAt: nowOf(deps).toISOString(),
    });
  } catch (err) {
    if (untrusted) throw err;
  }
}

interface WallInput {
  input: PrepareRunInput;
  home: string;
  sessionId: string;
  workspace: string;
  egress: SessionEgress | null;
  env: NodeJS.ProcessEnv;
}

/** A second line rather than the gate: a binary that never saw a wrapper still meets it. */
function wallFor(wall: WallInput): Sandboxed {
  const { input, home, sessionId, workspace, egress, env } = wall;
  const { command, options, deps } = input;
  if (options.untrusted !== true || egress === null) {
    return sandboxed(command, home, options.guard !== false, deps.guard);
  }
  const scratch = sessionScratch(sessionId);
  const temps = [...new Set([...SYSTEM_TEMPS, resolved(tmpdir())])];
  const preset = untrustedPreset({
    home,
    workspace,
    temps,
    scratch,
    binary: input.binary,
    proxyPort: egress.port,
  });
  Object.assign(env, preset.env);
  if (options.guard === false)
    return { command, guard: null, because: 'turned off with --no-guard' };
  const walled = untrustedSandbox(
    { command, home, sessionId, guard: preset.guard },
    deps.guard,
  );
  if (walled.guard === null) {
    throw new Error(
      `--untrusted needs a kernel sandbox, and here ${walled.because}.\n` +
        'Add --no-guard to run it with only the seams asking.',
    );
  }
  return walled;
}

/** The session's own temp directory, where package caches go since the home is walled off. */
function sessionScratch(sessionId: string): string {
  const path = join(resolved(tmpdir()), `memnox-${sessionId}`);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // A temp that will not resolve is used as spelled.
    return path;
  }
}

/**
 * The task, when one was given. Every dimension is optional and an omitted one is
 * undeclared rather than empty, since reporting a dimension never declared would invent drift.
 */
async function declareTask(
  home: string,
  sessionId: string,
  options: RunOptions,
  deps: RunDeps,
): Promise<SessionTask | null> {
  const scope: DeclaredScope = {
    ...listOf('paths', options.paths),
    ...listOf('repositories', options.repos),
    ...listOf('services', options.services),
    ...listOf('environments', options.envs),
  };
  if (options.task === undefined && isEmptyScope(scope) && options.investigate !== true) {
    return null;
  }

  const expected =
    options.expect === undefined ? undefined : Number.parseInt(options.expect, 10);
  if (expected !== undefined && (Number.isNaN(expected) || expected < 1)) {
    throw new Error('--expect takes a count, e.g. --expect 40');
  }

  const task = taskFor(
    {
      sessionId,
      statement: options.task ?? 'unstated',
      scope,
      ...(expected === undefined ? {} : { expectedActions: expected }),
      ...(options.investigate === true ? { intent: TASK_INTENT.INVESTIGATE } : {}),
    },
    nowOf(deps).toISOString(),
  );
  await new SessionTasks(home).declare(task);
  return task;
}

function listOf<TKey extends string>(
  key: TKey,
  value: string | undefined,
): Partial<Record<TKey, string[]>> {
  if (value === undefined) return {};
  const items = value
    .split(',')
    .map((each) => each.trim())
    .filter((each) => each.length > 0);
  return items.length === 0 ? {} : ({ [key]: items } as Record<TKey, string[]>);
}

/**
 * Best effort, and quiet about it: not being in a repository is the ordinary case for
 * somebody running an agent in a scratch directory, and it must not stop the agent.
 */
async function keepMilestone(
  sessionId: string,
  binary: string,
  deps: RunDeps,
): Promise<string | null> {
  try {
    const milestones = (deps.milestones ?? milestonesHere)();
    const taken = await milestones.take({
      at: nowOf(deps).toISOString(),
      reason: MILESTONE_REASON.SESSION,
      sessionId,
      note: `before ${binary}`,
    });
    // Retention runs where milestones are made, so a busy machine never piles up refs.
    await milestones.forget();
    return taken.id;
  } catch {
    return null;
  }
}

function milestonesHere(): Milestones {
  return new Milestones(new NodeGit(process.cwd()), new NodeWorktree(process.cwd()));
}

export function nowOf(deps: RunDeps): Date {
  return (deps.now ?? (() => new Date()))();
}
