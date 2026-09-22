import { execFileSync } from 'node:child_process';
import {
  actionResource,
  CLAIM_ANSWER,
  changesExternalState,
  keepClaimed,
  meetingReason,
  TOOL_CLASS,
  type IntendedAction,
  type LeaseHolder,
  type SharedActions,
  type ToolClass,
} from '@memnox/core';

/**
 * The outward action a command line takes, for the same register the MCP proxy asks.
 *
 * An agent that closes a pull request with `gh pr close 12` is doing what one calling
 * `close_pull_request` through the proxy does, and the two used to never meet: the
 * proxy claimed its call and the shell claimed nothing. So a command is read here
 * into the same shape, and a pull request is named by the same ref whichever surface
 * reached it.
 *
 * **Only what leaves the machine.** A read is never claimed, and neither is a
 * request that sends nothing: two agents fetching one page are not in each other's
 * way.
 *
 * **Named, never guessed.** The one thing a command acts on is read only for the
 * GitHub CLI's pull requests and issues, where the number is on the line. Anything
 * else is compared exactly, command line against command line.
 */

/** `gh` subcommands that name one pull request or issue by number or URL. */
const GH_NOUNS: Readonly<Record<string, string>> = {
  pr: 'pull_number',
  issue: 'issue_number',
};

/** `gh pr` and `gh issue` verbs that only look. */
const GH_READS: readonly string[] = ['view', 'list', 'status', 'diff', 'checks'];

/** The flags `gh` takes a repository in. */
const GH_REPO_FLAGS: readonly string[] = ['-R', '--repo'];

/** A pull request or issue by its URL, which `gh` takes in place of a number. */
const GH_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:pull|issues)\/(\d+)/;

/** `curl` flags that send a body, which is what makes a request an action. */
const SENDS_BODY: readonly string[] = [
  '-d',
  '--data',
  '--data-raw',
  '--data-binary',
  '--data-urlencode',
  '--json',
  '-F',
  '--form',
  '-T',
  '--upload-file',
];

/** `curl` flags that name the method. */
const METHOD_FLAGS: readonly string[] = ['-X', '--request'];

/** Methods that only look. */
const LOOKING: readonly string[] = ['GET', 'HEAD', 'OPTIONS'];

/** Where the repository comes from when the line does not say: the checkout's remote. */
export type RepositoryOf = () => { owner: string; repo: string } | null;

/** What the ruling on a command said, as far as a claim needs it. */
export interface RuledCommand {
  action: string;
  class: string;
  target?: string;
}

/**
 * The action this command would take, or null where there is nothing to claim.
 *
 * Null for a read, for a request that sends nothing, and for a command the
 * classifier could not place that names no one thing either: claiming those would
 * make two agents' lookups wait on each other.
 */
export function shellAction(
  binary: string,
  args: readonly string[],
  ruled: RuledCommand,
  repositoryOf: RepositoryOf = originRepository,
): IntendedAction | null {
  const resource = binary === 'gh' ? ghResource(args, repositoryOf) : undefined;
  if (!worthClaiming(binary, args, ruled.class, resource)) return null;
  return {
    operation: ruled.action,
    ...(ruled.target === undefined ? {} : { target: ruled.target }),
    /* The line itself, by position, so two agents typing the same command match
       and two typing different ones do not. It is hashed before it leaves. */
    arguments: Object.fromEntries(args.map((arg, index) => [String(index), arg])),
    ...(resource === undefined ? {} : { resource }),
  };
}

function worthClaiming(
  binary: string,
  args: readonly string[],
  toolClass: string,
  resource: string | undefined,
): boolean {
  if (toolClass === TOOL_CLASS.READ) return false;
  if (resource !== undefined) return true;
  if (binary === 'curl') return sendsSomething(args);
  return changesExternalState(toolClass as ToolClass);
}

/** Whether a `curl` line sends a body or asks for a method that changes something. */
function sendsSomething(args: readonly string[]): boolean {
  if (args.some((arg) => SENDS_BODY.includes(arg) || isInlineBody(arg))) return true;
  const at = args.findIndex((arg) => METHOD_FLAGS.includes(arg));
  if (at === -1) return false;
  const method = args[at + 1];
  return method !== undefined && !LOOKING.includes(method.toUpperCase());
}

/** `--data=...` and `-dvalue`, which carry the body in the flag itself. */
function isInlineBody(arg: string): boolean {
  if (arg.startsWith('--data=') || arg.startsWith('--json=')) return true;
  return arg.length > 2 && arg.startsWith('-d') && !arg.startsWith('--');
}

/**
 * The pull request or issue a `gh` line acts on, spelled the way the proxy spells it.
 *
 * Undefined for a read, for a line that names no number, and where the repository
 * cannot be told: a pull request number without its repository is not one thing.
 */
function ghResource(
  args: readonly string[],
  repositoryOf: RepositoryOf,
): string | undefined {
  const [noun, verb, subject] = args;
  if (noun === undefined || verb === undefined || subject === undefined) return undefined;
  const field = GH_NOUNS[noun];
  if (field === undefined || GH_READS.includes(verb)) return undefined;

  const byUrl = GH_URL.exec(subject);
  if (byUrl !== null) {
    const [, owner, repo, number] = byUrl;
    if (owner === undefined || repo === undefined || number === undefined)
      return undefined;
    return actionResource('github', { owner, repo, [field]: number });
  }
  if (!/^\d+$/.test(subject)) return undefined;

  const repository = repoFlag(args) ?? repositoryOf();
  if (repository === null) return undefined;
  return actionResource('github', { ...repository, [field]: subject });
}

function repoFlag(args: readonly string[]): { owner: string; repo: string } | null {
  const at = args.findIndex((arg) => GH_REPO_FLAGS.includes(arg));
  if (at === -1) return null;
  return ownerAndRepo(args[at + 1] ?? '');
}

function ownerAndRepo(slug: string): { owner: string; repo: string } | null {
  const match = /^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(slug);
  if (match === null) return null;
  const [, owner, repo] = match;
  if (owner === undefined || repo === undefined) return null;
  return { owner, repo };
}

/** Milliseconds. Asked only for a `gh` line that acts on one thing. */
const GIT_TIMEOUT_MS = 2_000;

/** The GitHub repository `origin` points at, or null where it is not one. */
function originRepository(): { owner: string; repo: string } | null {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
    const match = /github\.com[:/](.+)$/.exec(url);
    if (match === null) return null;
    return ownerAndRepo(match[1] ?? '');
  } catch {
    // Not a checkout, or no remote: the line names no repository and neither does this.
    return null;
  }
}

/** Refused with a sentence naming who has it, or free to run and holding it. */
export type ShellClaim = { refused: string } | { release: () => Promise<void> };

/** What a command that claimed nothing holds: nothing, and so nothing to finish. */
const NOTHING_HELD: ShellClaim = { release: async () => undefined };

/**
 * Whether another agent has this, and if not, the claim held while it runs.
 *
 * Every answer that is not a meeting lets the command run, the unreachable one
 * included: this is coordination rather than safety, and a network hiccup must not
 * be the reason a command stops. A claim that was taken is renewed while the
 * command runs and finished when it exits, so the thing is free the moment the work
 * is done.
 */
export async function claimShellAction(
  action: IntendedAction,
  actions: SharedActions,
  holder: LeaseHolder,
): Promise<ShellClaim> {
  const outcome = await actions.claim(action, holder);
  if (outcome.answer === CLAIM_ANSWER.UNKNOWN) return NOTHING_HELD;
  if (outcome.answer === CLAIM_ANSWER.MINE) {
    return { release: keepClaimed(actions, action, holder) };
  }
  return { refused: meetingReason(outcome) };
}
