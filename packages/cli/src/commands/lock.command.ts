/** `memnox lock`: who holds what, from a third terminal, and taking or letting go of it. */
import { homedir } from 'node:os';
import { relative, resolve } from 'node:path';
import type { Command } from 'commander';
import {
  CloudLeases,
  DEFAULT_LEASE_MINUTES,
  EXIT,
  FREE_OUTCOME,
  LEASE_OUTCOME,
  LeaseRegistry,
  holderPid,
  describeLease,
  SESSION_VAR,
  normalizeLeasePath,
  type FreeOutcome,
  type Lease,
  type LeaseHolder,
} from '@memnox/core';
import { pidSessionId } from '@memnox/interceptors';
import type { CliContext } from '../cli-context';
import { confirmOnTerminal, type Confirm } from '../confirm';
import { describeCount } from '../plural';
import { TONE } from '../flow';
import { minutesFrom } from '../duration';
import { NodeGit } from '../node-git';

/** Enough of what a holder has been doing to end an argument, and never a log. */
const ACTIVITY_SHOWN = 3;

/** What the record says when a person freed lines without saying why. */
const DEFAULT_FREE_REASON = 'freed by a person from the terminal';

/** What `lock` reads from outside itself, each injected so a test can pin it. */
interface LockSeams {
  home: () => string;
  now: () => Date;
  project: () => string;
  env: NodeJS.ProcessEnv;
  confirm: Confirm;
}

/** Everything the subcommands share: the register, who is asking, and when. */
interface LockDeps {
  context: CliContext;
  seams: LockSeams;
  home: string;
  registry: LeaseRegistry;
  holder: LeaseHolder;
  moment: string;
}

interface LockOptions {
  list?: boolean;
  for: string;
  release?: string;
  forget?: boolean;
  agent: string;
  free?: string;
  reason?: string;
}

/** Leases block work for a reason that is not safety, so they have to be listable and takeable. */
export function registerLockCommand(
  program: Command,
  context: CliContext,
  overrides: Partial<LockSeams> = {},
): void {
  const seams: LockSeams = {
    home: homedir,
    now: () => new Date(),
    project: () => process.cwd(),
    env: process.env,
    confirm: confirmOnTerminal,
    ...overrides,
  };
  program
    .command('lock [path]')
    .description('Hold a path while you work on it, so a second agent waits')
    .option('--list', 'show every lease held on this machine')
    .option('--for <duration>', 'how long, e.g. 30m', String(DEFAULT_LEASE_MINUTES))
    .option('--release <id>', 'let one go early')
    .option('--forget', 'drop the records of leases nobody holds')
    .option('--agent <name>', 'who is taking it', 'you')
    .option('--free <id>', "free lines another machine's agent holds, from a refusal")
    .option('--reason <why>', 'why they are being freed, kept on the record')
    .action(async (path: string | undefined, options: LockOptions) =>
      runLock(buildLockDeps(context, seams, options.agent), path, options),
    );
}

/** The register, and a holder that is this shell's session rather than this short process. */
function buildLockDeps(context: CliContext, seams: LockSeams, agent: string): LockDeps {
  const home = seams.home();
  // The shell, which outlives this command, and never init, which could never be found dead.
  const owner = holderPid(process.ppid, process.pid);
  return {
    context,
    seams,
    home,
    registry: new LeaseRegistry(home),
    holder: {
      agent,
      // The session `memnox run` set, so a lease by hand and one at the seam renew each other.
      sessionId: seams.env[SESSION_VAR] ?? pidSessionId(owner),
      pid: owner,
    },
    moment: seams.now().toISOString(),
  };
}

/** Picks what the flags asked for: free, forget, release, list, or take a path. */
async function runLock(
  deps: LockDeps,
  path: string | undefined,
  options: LockOptions,
): Promise<void> {
  deps.context.flow.open('memnox lock');
  if (options.free !== undefined) return runFree(deps, options.free, options.reason);
  if (options.forget === true) return runForget(deps);
  if (options.release !== undefined) return runRelease(deps, options.release);
  if (options.list === true || path === undefined) return renderHeld(deps);
  return runTake(deps, path, options);
}

/** Drops the records of leases nobody holds any more. */
async function runForget(deps: LockDeps): Promise<void> {
  const dropped = await deps.registry.forget(deps.moment);
  deps.context.flow.close(
    dropped === 0 ? 'Nothing to forget.' : `Forgot ${dropped} finished leases.`,
  );
}

/** Lets one lease go early, refusing where it belongs to another session. */
async function runRelease(deps: LockDeps, id: string): Promise<void> {
  const result = await deps.registry.release(id, deps.holder, deps.moment);
  if (result.outcome === LEASE_OUTCOME.NOT_FOUND) throw new Error(`No lease ${id}.`);
  if (result.outcome === LEASE_OUTCOME.NOT_YOURS) {
    throw new Error(
      `${id} belongs to another session. Take it with --agent and a reason, or wait.`,
    );
  }
  deps.context.flow.close(deps.context.style.ok(`Released ${id}.`));
}

/** Everything held on this machine right now. */
async function renderHeld(deps: LockDeps): Promise<void> {
  const { flow } = deps.context;
  const held = await deps.registry.held(deps.moment);
  if (held.length === 0) {
    flow.close('Nothing is held right now.');
    flow.hint('Hold a path with "memnox lock <path>".');
    return;
  }
  flow.list(
    'Held on this machine',
    held.map((lease) => ({
      tone: TONE.WARN,
      text: `${lease.id}  ${describeLease(lease, deps.moment)}`,
      // What the holder has been doing is the half that ends the argument.
      detail: lease.activity.slice(-ACTIVITY_SHOWN),
    })),
  );
  flow.close(`${describeCount(held.length, 'path is', 'paths are')} held.`);
  flow.hint('Let one go with "memnox lock --release <id>".');
}

/** Takes the path a person named, and nothing wider. */
async function runTake(
  deps: LockDeps,
  path: string,
  options: LockOptions,
): Promise<void> {
  const project = deps.seams.project();
  const scope = await resolveScope(project, path);
  const result = await deps.registry.take(
    {
      path: scope,
      holder: deps.holder,
      minutes: minutesFrom(options.for, '--for'),
      activity: `held by hand from ${project}`,
    },
    deps.moment,
  );

  if (result.outcome === LEASE_OUTCOME.UNUSABLE_PATH) {
    throw new Error(`${path} is not a path a lease can be reasoned about.`);
  }
  if (result.outcome === LEASE_OUTCOME.HELD_BY_ANOTHER) {
    renderHeldByAnother(deps, result.holding);
    throw new Error(`${scope} is held by somebody else.`);
  }
  renderHolding(deps, result.lease, options.agent);
}

function renderHeldByAnother(deps: LockDeps, holding: Lease): void {
  deps.context.flow.list('Held by somebody else', [
    {
      tone: TONE.WARN,
      text: describeLease(holding, deps.moment),
      detail: [
        ...holding.activity.slice(-ACTIVITY_SHOWN),
        `it expires at ${holding.expiresAt} on its own`,
      ],
    },
  ]);
}

function renderHolding(deps: LockDeps, lease: Lease, agent: string): void {
  const { flow, style } = deps.context;
  const shown = lease.path === '' ? '.' : lease.path;
  flow.rows('Holding', [
    { label: 'path', value: shown },
    { label: 'lease', value: lease.id },
    { label: 'until', value: lease.expiresAt },
    { label: 'agent', value: agent },
  ]);
  flow.close(style.ok(`Holding ${shown}.`));
  // Every lease expires. Saying so here is what stops anybody relying on one.
  flow.hint('It expires on its own; nothing waits for ever on it.');
  flow.hint('Let it go early with "memnox lock --release".');
}

/**
 * Exactly the path that was named, relative to the repository. The seam widens a write to
 * its directory; a person who typed a path has already said what they mean.
 */
async function resolveScope(project: string, path: string): Promise<string> {
  const root = await new NodeGit(project).root();
  if (root === null) {
    throw new Error('A lease is repository-relative, and this is not a repository.');
  }
  const wanted = normalizeLeasePath(relative(root, resolve(project, path)));
  if (wanted === null) {
    throw new Error(`${path} is outside this repository, so nothing can lease it.`);
  }
  return wanted;
}

/**
 * A person freeing lines another machine's agent holds, asked on a terminal and nowhere
 * else, because the refused agent reads this command and must not lift its own block.
 */
async function runFree(
  deps: LockDeps,
  id: string,
  reason: string | undefined,
): Promise<void> {
  const { flow, style } = deps.context;
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    flow.close(
      style.warn('This asks a person to confirm, so it only runs in a terminal.'),
    );
    process.exitCode = EXIT.FAILED;
    return;
  }
  const yes = await deps.seams.confirm(
    `Free ${id}? The agent holding those lines loses them now, and the record keeps that you did.`,
    false,
  );
  if (!yes) {
    flow.close('Left as it was.');
    return;
  }
  const said =
    reason === undefined || reason.trim() === '' ? DEFAULT_FREE_REASON : reason;
  const outcome = await new CloudLeases(deps.home).free(id, deps.holder, said);
  renderFreed(deps.context, outcome);
}

/** What the workspace said about the lines a person asked to free. */
function renderFreed(context: CliContext, outcome: FreeOutcome): void {
  const { flow, style } = context;
  if (outcome === FREE_OUTCOME.FREED) {
    flow.close(style.ok('Freed. The agent that was waiting can write those lines now.'));
    return;
  }
  if (outcome === FREE_OUTCOME.GONE) {
    flow.close('Nobody holds it any more, so there was nothing to free.');
    return;
  }
  if (outcome === FREE_OUTCOME.NOT_ENROLLED) {
    flow.close('This machine is not connected, so it cannot reach the workspace.');
    flow.hint('Connect it with "memnox login".');
    process.exitCode = EXIT.FAILED;
    return;
  }
  flow.close(style.warn('The workspace could not free it. Try again in a moment.'));
  process.exitCode = EXIT.FAILED;
}
