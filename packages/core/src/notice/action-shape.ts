/**
 * What one action is, for noticing: whether it is worth remembering, whether it takes
 * something or sends it, and whether it goes outward or cannot be undone. Tables only.
 */
import { basename } from 'node:path';

import type { ActionRequest } from '../domain/action-event';
import { ACTION } from '../constants/action.constants';
import { RISK_LEVEL, type RiskLevel } from '../constants/risk.constants';
import {
  changesExternalState,
  classifyTool,
  TOOL_CLASS,
  type ToolClass,
} from '../discovery/classify';
import { CHAIN_LINK, chainLinkOfName, type ChainLink } from '../discovery/composition';
import { isCredentialPath } from '../discovery/resource';
import { nameSegments } from '../discovery/surface';
import { classifyRisk } from '../policy/risk-classifier';
import { REVERSIBILITY, reversibilityOf } from '../session/reversibility';
import { verbTableFor } from '../verbs/tables';
import { hasTag, VERB_TAG, verbForAction, type Verb } from '../verbs/verb-table';

/** Something worth remembering having done, and how to say doing it the first time. */
export interface Novelty {
  /** The operation class and the target it was done to, as one comparable string. */
  key: string;
  /** "first request to api.example.com", for the sentence a person reads. */
  first: string;
}

export interface ActionShape {
  /** Null when doing this for the first time is ordinary, such as reading a README. */
  novelty: Novelty | null;
  /** Acquire or emit, when this is one end of an exfiltration path. */
  link: ChainLink | null;
  /** The step in words, as a chain reason names it. */
  step: string;
  /** Leaves this machine: a request, a push, a message. */
  outward: boolean;
  destructive: boolean;
}

const MCP_PREFIX = 'mcp.';

/** Actions ruled on by where they go, and how reaching that place is said. */
const HOST_ACTIONS: Readonly<Record<string, string>> = {
  'http.request': 'request to',
  'http.connect': 'connection to',
  'browser.navigate': 'visit to',
  'network.ssh': 'ssh session to',
};

const PUSH_ACTIONS: readonly string[] = [ACTION.GIT_PUSH, ACTION.GIT_PUSH_FORCE];
const READ_ACTIONS: readonly string[] = [ACTION.FILESYSTEM_READ, 'file.read'];
const DESTRUCTIVE_ACTIONS: readonly string[] = [
  ACTION.FILESYSTEM_DELETE,
  ACTION.GIT_PUSH_FORCE,
  ACTION.GIT_RESET,
  ACTION.GIT_CLEAN,
];

/** Outward without a host to name: the export an egress seam rules on. */
const OUTWARD_ACTIONS: readonly string[] = ['data.export'];

/** Directories whose every file is a credential store, beside the files named by path. */
const SENSITIVE_DIRS: readonly RegExp[] = [
  /(^|\/)\.(ssh|aws|gnupg|kube|docker|azure)(\/|$)/,
  /(^|\/)\.config\/(gh|gcloud)(\/|$)/,
];

/** A shell line whose first command prints every variable, secrets included. */
const ENV_DUMPERS: readonly string[] = ['env', 'printenv'];

/** What an MCP read has to be about before taking it counts as acquiring something. */
const SECRET_SUBJECTS: readonly string[] = [
  'secret',
  'secrets',
  'credential',
  'credentials',
  'token',
  'tokens',
  'password',
  'passwords',
  'key',
  'keys',
];

const HIGH_RISK: readonly RiskLevel[] = [RISK_LEVEL.HIGH, RISK_LEVEL.CRITICAL];

/** The home prefix shortened to `~`, so a reason reads the way the path is usually typed. */
export function shapeOf(request: ActionRequest, home = ''): ActionShape {
  const { action, target } = request;
  return (
    mcpShape(action, target) ??
    hostShape(action, target) ??
    pushShape(action, target) ??
    acquireShape(action, target === undefined ? undefined : shortened(target, home)) ??
    plainShape(action)
  );
}

/** Destructive and irreversible, in the words a prompt and a hook reason both print. */
export function riskLabelFor(action: string): string | null {
  const shape = shapeOf({ action });
  const irreversible =
    reversibilityOf(action, classOfAction(action)) === REVERSIBILITY.IRREVERSIBLE;
  if (shape.destructive && irreversible)
    return 'This is destructive and cannot be undone.';
  if (shape.destructive) return 'This is destructive.';
  if (irreversible) return 'This cannot be undone.';
  return null;
}

/** Whether anything about this shape can raise a notice, so the ordinary call reads no file. */
export function isNoticeable(shape: ActionShape): boolean {
  return (
    shape.novelty !== null || shape.link !== null || shape.outward || shape.destructive
  );
}

function mcpShape(action: string, target: string | undefined): ActionShape | null {
  if (!action.startsWith(MCP_PREFIX)) return null;
  const tool = action.slice(MCP_PREFIX.length);
  const server = target ?? 'its server';
  const toolClass = classifyTool({ name: tool }).class;
  const link = chainLinkOfName(tool);
  const acquires =
    link === CHAIN_LINK.ACQUIRE &&
    nameSegments(tool).some((segment) => SECRET_SUBJECTS.includes(segment));
  const emits = link === CHAIN_LINK.EMIT || toolClass === TOOL_CLASS.COMMUNICATION;
  const destructive = toolClass === TOOL_CLASS.DESTRUCTIVE || isHighRisk(action);
  // A read-only tool used for the first time is ordinary; one that changes or takes is not.
  const remembered = destructive || acquires || toolClass !== TOOL_CLASS.READ;
  return {
    novelty: remembered
      ? { key: `mcp:${server}/${tool}`, first: `first use of ${tool} on ${server}` }
      : null,
    link: emits ? CHAIN_LINK.EMIT : acquires ? CHAIN_LINK.ACQUIRE : null,
    step: `${server}.${tool}`,
    // A write through a server changes a system this machine does not own.
    outward: emits || changesExternalState(toolClass),
    destructive,
  };
}

function hostShape(action: string, target: string | undefined): ActionShape | null {
  const reaching = HOST_ACTIONS[action];
  if (reaching === undefined) return null;
  const host = target === undefined ? null : hostOf(target);
  const where = host ?? 'the network';
  return {
    novelty:
      host === null ? null : { key: `host:${host}`, first: `first ${reaching} ${host}` },
    link: CHAIN_LINK.EMIT,
    step: `a ${reaching} ${where}`,
    outward: true,
    destructive: false,
  };
}

function pushShape(action: string, target: string | undefined): ActionShape | null {
  if (!PUSH_ACTIONS.includes(action)) return null;
  const remote = (target ?? '').trim().split(/\s+/)[0] || 'the default remote';
  const force = action === ACTION.GIT_PUSH_FORCE;
  return {
    novelty: force
      ? { key: `destructive:${action}`, first: 'first force push' }
      : { key: `push:${remote}`, first: `first push to ${remote}` },
    link: CHAIN_LINK.EMIT,
    step: force ? 'git push --force' : 'git push',
    outward: true,
    destructive: force,
  };
}

function acquireShape(action: string, shown: string | undefined): ActionShape | null {
  const step = acquiredStep(action, shown);
  if (step === null) return null;
  return {
    novelty: { key: `sensitive:${step.what}`, first: `first ${step.words}` },
    link: CHAIN_LINK.ACQUIRE,
    step: step.words.replace(/^read of /, 'read '),
    outward: false,
    destructive: false,
  };
}

/** Reading a credential file, a secret through a CLI, or the whole environment. */
function acquiredStep(
  action: string,
  shown: string | undefined,
): { what: string; words: string } | null {
  if (READ_ACTIONS.includes(action) && shown !== undefined && isSensitivePath(shown)) {
    return { what: shown, words: `read of ${shown}` };
  }
  const verb = verbOf(action);
  if (verb !== null && verb.class === TOOL_CLASS.READ && hasTag(verb, VERB_TAG.SECRETS)) {
    return { what: action, words: `secret read with ${action}` };
  }
  if (action === ACTION.SHELL_EXECUTE && shown !== undefined && isEnvDump(shown)) {
    return { what: 'environment', words: 'dump of the environment' };
  }
  return null;
}

function plainShape(action: string): ActionShape {
  const destructive =
    DESTRUCTIVE_ACTIONS.includes(action) ||
    isHighRisk(action) ||
    verbOf(action)?.class === TOOL_CLASS.DESTRUCTIVE;
  const outward = OUTWARD_ACTIONS.includes(action);
  return {
    novelty: destructive
      ? { key: `destructive:${action}`, first: `first ${action}` }
      : null,
    link: outward ? CHAIN_LINK.EMIT : null,
    step: action,
    outward,
    destructive,
  };
}

function isHighRisk(action: string): boolean {
  return HIGH_RISK.includes(classifyRisk(action));
}

function verbOf(action: string): Verb | null {
  return verbForAction(action, verbTableFor);
}

function classOfAction(action: string): ToolClass {
  if (action.startsWith(MCP_PREFIX)) {
    return classifyTool({ name: action.slice(MCP_PREFIX.length) }).class;
  }
  return verbOf(action)?.class ?? TOOL_CLASS.UNKNOWN;
}

function isSensitivePath(path: string): boolean {
  return isCredentialPath(path) || SENSITIVE_DIRS.some((pattern) => pattern.test(path));
}

/** `env` alone or with flags only prints; `env FOO=1 make` runs make. */
function isEnvDump(line: string): boolean {
  const command = line.trim().split(/[|;&]/)[0] ?? '';
  const [first, ...rest] = command.trim().split(/\s+/);
  if (first === undefined) return false;
  const binary = basename(first);
  if (!ENV_DUMPERS.includes(binary)) return false;
  if (binary === 'printenv') return true;
  const firstArgument = rest[0];
  return firstArgument === undefined || firstArgument.startsWith('-');
}

/** A URL, an authority, or `user@host`, reduced to the host a person recognises. */
function hostOf(target: string): string | null {
  if (target.includes('://')) {
    try {
      return new URL(target).hostname || null;
    } catch {
      // Not a URL after all; read it as an authority below.
    }
  }
  const authority = target.split('/')[0] ?? '';
  const host = (authority.split('@').pop() ?? '').replace(/:\d+$/, '');
  return host === '' ? null : host.toLowerCase();
}

function shortened(path: string, home: string): string {
  if (home === '' || !path.startsWith(`${home}/`)) return path;
  return `~/${path.slice(home.length + 1)}`;
}
