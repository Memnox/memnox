/**
 * The layer under the rules that nobody has to write: a session's writes stay in its
 * repository, and an untrusted repository or an agent on probation asks before it acts
 * outside the machine. It only ever turns an allow into an ask, so a deny stays a deny.
 */
import { isAbsolute, join, relative, resolve } from 'node:path';

import { ACTION } from '../constants/action.constants';
import {
  ACTION_CLASS,
  CLASS_BASIS,
  LOCAL_NAMESPACES,
} from '../constants/action-class.constants';
import { TOOL_CLASS } from '../discovery/classify';
import { classifyActionClass } from '../domain/action-class';
import type { ActionRequest } from '../domain/action-event';
import { matchesAny } from '../policy/pattern-matcher';
import { verbForAction } from '../verbs/verb-table';
import { verbTableFor } from '../verbs/tables';

/** What an action does, as containment reads it: only a read is never asked about. */
export const CONTAINED = {
  READ: 'read',
  WRITE: 'write',
  OUTWARD: 'outward',
  DESTRUCTIVE: 'destructive',
} as const;

export type ContainedClass = (typeof CONTAINED)[keyof typeof CONTAINED];

/** The signal an ask carries, so the ledger says which part of containment asked. */
export const CONTAINMENT_SIGNAL = {
  BOUNDARY: 'containment:boundary',
  UNTRUSTED: 'containment:untrusted',
  PROBATION: 'containment:probation',
} as const;

/**
 * Hosts an untrusted session or an agent on probation reaches without asking: package
 * registries, which is what installing a repository needs, and the model providers
 * the agents themselves talk to, which would otherwise ask on every turn.
 */
export const QUIET_DESTINATIONS: readonly string[] = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'crates.io',
  'index.crates.io',
  'static.crates.io',
  'proxy.golang.org',
  'sum.golang.org',
  'rubygems.org',
  'repo.maven.apache.org',
  'repo1.maven.org',
  'api.anthropic.com',
  'api.openai.com',
  'chatgpt.com',
  'generativelanguage.googleapis.com',
];

/** An agent or a server still on probation, and how a person ends it early. */
export interface ContainedProbation {
  name: string;
  /** When it ends on its own, as an ISO date. */
  until: string;
  /** The command that trusts it now, quoted in the ask. */
  trustCommand: string;
}

export interface Containment {
  /** The repository the session works in; a write outside it asks. */
  root?: string;
  /** Globs the task declared, relative to the root; a write outside them asks too. */
  paths?: readonly string[];
  /** Where a relative target is resolved from when the request names no directory. */
  cwd?: string;
  /** The home directory, so `~/x` is read as the path it is. */
  home?: string;
  /** Directories a write lands in without asking, such as the system temp. */
  scratch?: readonly string[];
  /** Every outward or destructive action asks, bar the quiet destinations. */
  untrusted?: boolean;
  probation?: ContainedProbation;
  /** Destinations that never ask on containment's account. */
  quietHosts?: readonly string[];
}

/** Why containment asked, and which part of it did. */
export interface ContainmentAsk {
  reason: string;
  signal: string;
}

const FILE_WRITES: readonly string[] = [
  ACTION.FILESYSTEM_WRITE,
  ACTION.FILESYSTEM_DELETE,
];
const NETWORK: readonly string[] = [ACTION.HTTP_REQUEST, ACTION.HTTP_CONNECT];
/** Local namespaces whose action still reaches another machine. */
const OUTWARD_ACTIONS: readonly string[] = [
  ACTION.GIT_PUSH,
  ACTION.BROWSER_NAVIGATE,
  ...NETWORK,
];

/** The class of one action, from the caller's tool class where it has one. */
export function containedClassOf(action: string, toolClass?: string): ContainedClass {
  if (action === ACTION.FILESYSTEM_DELETE) return CONTAINED.DESTRUCTIVE;
  if (action === ACTION.FILESYSTEM_WRITE) return CONTAINED.WRITE;
  if (OUTWARD_ACTIONS.includes(action)) return CONTAINED.OUTWARD;
  const stated = fromToolClass(action, toolClass);
  if (stated !== null) return stated;
  const verb = verbForAction(action, verbTableFor);
  if (verb !== null) return fromToolClass(action, verb.class) ?? CONTAINED.READ;
  const classified = classifyActionClass(action);
  if (classified.class === ACTION_CLASS.DESTRUCTIVE) return CONTAINED.DESTRUCTIVE;
  // An unproven action is not called outward here, or every unknown CLI would ask.
  return classified.basis === CLASS_BASIS.OUTWARD ? CONTAINED.OUTWARD : CONTAINED.READ;
}

function fromToolClass(
  action: string,
  toolClass: string | undefined,
): ContainedClass | null {
  if (toolClass === TOOL_CLASS.READ) return CONTAINED.READ;
  if (toolClass === TOOL_CLASS.DESTRUCTIVE) return CONTAINED.DESTRUCTIVE;
  if (toolClass === TOOL_CLASS.COMMUNICATION) return CONTAINED.OUTWARD;
  if (toolClass !== TOOL_CLASS.WRITE) return null;
  // A write through a CLI that is not local changes somebody else's state.
  const namespace = action.split('.')[0] ?? action;
  return LOCAL_NAMESPACES.includes(namespace) ? CONTAINED.WRITE : CONTAINED.OUTWARD;
}

/** Null where containment has nothing to say and the rules' allow stands. */
export function containmentAsk(
  request: ActionRequest,
  containment: Containment,
  toolClass?: string,
): ContainmentAsk | null {
  const kind = containedClassOf(request.action, toolClass);
  if (kind === CONTAINED.READ) return null;
  if (isQuiet(request, containment)) return null;
  return (
    boundaryAsk(request, containment) ??
    untrustedAsk(kind, containment) ??
    probationAsk(containment)
  );
}

/** A write or delete outside the repository, or outside the paths the task declared. */
function boundaryAsk(
  request: ActionRequest,
  containment: Containment,
): ContainmentAsk | null {
  const { root } = containment;
  const target = request.target;
  if (
    root === undefined ||
    target === undefined ||
    !FILE_WRITES.includes(request.action)
  ) {
    return null;
  }
  const path = absoluteOf(
    target,
    request.workingDirectory ?? containment.cwd ?? root,
    containment.home,
  );
  if ((containment.scratch ?? []).some((dir) => isInside(dir, path))) return null;
  if (!isInside(root, path)) {
    return {
      reason: `${path} is outside ${root}, where this session works, so a write there asks first.`,
      signal: CONTAINMENT_SIGNAL.BOUNDARY,
    };
  }
  const declared = containment.paths ?? [];
  if (declared.length === 0) return null;
  if (matchesAny(declared, relative(root, path)) || matchesAny(declared, path))
    return null;
  return {
    reason: `${relative(root, path)} is outside the paths this task declared (${declared.join(', ')}), so a write there asks first.`,
    signal: CONTAINMENT_SIGNAL.BOUNDARY,
  };
}

function untrustedAsk(
  kind: ContainedClass,
  containment: Containment,
): ContainmentAsk | null {
  if (containment.untrusted !== true) return null;
  if (kind !== CONTAINED.OUTWARD && kind !== CONTAINED.DESTRUCTIVE) return null;
  return {
    reason: `This session runs an untrusted repository, so every ${kind} action asks first.`,
    signal: CONTAINMENT_SIGNAL.UNTRUSTED,
  };
}

function probationAsk(containment: Containment): ContainmentAsk | null {
  const probation = containment.probation;
  if (probation === undefined) return null;
  return {
    reason: `${probation.name} is on probation until ${probation.until.slice(0, 10)}, so its writes and outward actions ask first. "${probation.trustCommand}" ends it now.`,
    signal: CONTAINMENT_SIGNAL.PROBATION,
  };
}

/** A registry or the agent's own model provider, reached without asking on containment's account. */
function isQuiet(request: ActionRequest, containment: Containment): boolean {
  if (!NETWORK.includes(request.action) || request.target === undefined) return false;
  const host = hostOfDestination(request.target);
  if (host === null) return false;
  return (containment.quietHosts ?? QUIET_DESTINATIONS).some(
    (quiet) => host === quiet || host.endsWith(`.${quiet}`),
  );
}

/** The host a URL or a `host:port` authority names, lower case, or null for neither. */
export function hostOfDestination(target: string): string | null {
  try {
    const url = new URL(target.includes('://') ? target : `https://${target}`);
    return url.hostname === ''
      ? null
      : url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    // Not a destination at all, which containment reads as no host.
    return null;
  }
}

function absoluteOf(target: string, base: string, home: string | undefined): string {
  if (home !== undefined && (target === '~' || target.startsWith('~/'))) {
    return join(home, target.slice(1));
  }
  return isAbsolute(target) ? resolve(target) : resolve(base, target);
}

/** True for the directory itself and anything under it. */
export function isInside(dir: string, path: string): boolean {
  const between = relative(resolve(dir), resolve(path));
  return between === '' || (!between.startsWith('..') && !isAbsolute(between));
}
