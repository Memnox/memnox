import { execFileSync } from 'node:child_process';
import {
  ownProcessEnv,
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
 * The outward action a command line takes, in the shape the MCP
 * proxy uses, so `gh pr close 12` and a `close_pull_request`
 * call meet in one register. Reads are never claimed.
 */

/** The binaries whose lines are read for what they act on. */
const BINARY = { GH: 'gh', CURL: 'curl' } as const;

/** The provider a `gh` resource is filed under, as the proxy names the GitHub server. */
const GITHUB_PROVIDER = 'github';

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

export interface GitHubRepository {
  owner: string;
  repo: string;
}

/** Where the repository comes from when the line does not say: the checkout's remote. */
export type RepositoryOf = () => GitHubRepository | null;

/** What the ruling on a command said, as far as a claim needs it. */
export interface RuledCommand {
  action: string;
  class: string;
  target?: string;
}

/**
 * The action this command would take, or null for a read, a request that sends nothing,
 * or an unclassified command naming no one thing, so no two agents' lookups wait.
 */
export function shellAction(
  binary: string,
  args: readonly string[],
  ruled: RuledCommand,
  repositoryOf: RepositoryOf = originRepository,
): IntendedAction | null {
  const resource = binary === BINARY.GH ? ghResource(args, repositoryOf) : undefined;
  if (!isWorthClaiming(binary, args, ruled.class, resource)) return null;
  return {
    operation: ruled.action,
    ...(ruled.target === undefined ? {} : { target: ruled.target }),
    // The line by position, so two agents typing the
    // same command match. It is hashed before it leaves.
    arguments: Object.fromEntries(args.map((arg, index) => [String(index), arg])),
    ...(resource === undefined ? {} : { resource }),
  };
}

function isWorthClaiming(
  binary: string,
  args: readonly string[],
  toolClass: string,
  resource: string | undefined,
): boolean {
  if (toolClass === TOOL_CLASS.READ) return false;
  if (resource !== undefined) return true;
  if (binary === BINARY.CURL) return isSending(args);
  // A class string the ledger does not know compares unequal
  // to every changing class, which is the safe answer.
  return changesExternalState(toolClass as ToolClass);
}

/** Whether a `curl` line sends a body or asks for a method that changes something. */
function isSending(args: readonly string[]): boolean {
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
 * The pull request or issue a `gh` line acts on, spelled the way the proxy spells it, or
 * undefined for a read or a number whose repository is unknown.
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
    return actionResource(GITHUB_PROVIDER, { owner, repo, [field]: number });
  }
  if (!/^\d+$/.test(subject)) return undefined;

  const repository = repoFlag(args) ?? repositoryOf();
  if (repository === null) return undefined;
  return actionResource(GITHUB_PROVIDER, { ...repository, [field]: subject });
}

function repoFlag(args: readonly string[]): GitHubRepository | null {
  const at = args.findIndex((arg) => GH_REPO_FLAGS.includes(arg));
  if (at === -1) return null;
  return ownerAndRepo(args[at + 1] ?? '');
}

function ownerAndRepo(slug: string): GitHubRepository | null {
  const match = /^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(slug);
  if (match === null) return null;
  const [, owner, repo] = match;
  if (owner === undefined || repo === undefined) return null;
  return { owner, repo };
}

/** Milliseconds. Asked only for a `gh` line that acts on one thing. */
const GIT_TIMEOUT_MS = 2_000;

/** The GitHub repository `origin` points at, or null where it is not one. */
function originRepository(): GitHubRepository | null {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      // The real git, or asking about `gh` runs the git interceptor inside this one.
      env: ownProcessEnv(),
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
 * Whether another agent has this, and if not, the claim held while it runs. Any answer
 * but a meeting lets the command run, since this is coordination rather than safety.
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
