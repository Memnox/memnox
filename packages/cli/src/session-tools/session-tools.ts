/**
 * The tools the session server offers, and the one rule over the list: nothing here lets
 * an agent allow, approve, trust, unfreeze, change a mode or edit a rule, since it would approve itself.
 */
import {
  decisionsTool,
  replayTool,
  statusTool,
  whyTool,
  type SessionToolDeps,
  type ToolArgs,
} from './read-tools';
import { rewindTool, type RewindSeams } from './rewind-tool';

/** A tool as `tools/list` describes it; the annotations are how a host decides to ask. */
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: 'string'; description: string }>;
  };
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: false };
}

/**
 * Words no tool name may carry. Asserted in a test, because the day one does, an agent
 * can grant itself what its person was asked for. A person does those at a terminal or the console.
 */
export const NEVER_OFFERED: readonly string[] = [
  'allow',
  'approve',
  'grant',
  'trust',
  'unfreeze',
  'freeze',
  'lift',
  'mode',
  'rule',
  'policy',
  'enroll',
  'enrol',
];

function readTool(
  name: string,
  description: string,
  properties: ToolDefinition['inputSchema']['properties'] = {},
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  };
}

const SESSION_ARG = {
  type: 'string',
  description: "a session id; this agent's own latest when left out",
} as const;

export const SESSION_TOOLS: readonly ToolDefinition[] = [
  readTool(
    'why',
    'Why Memnox refused or asked about something in this session: the rule, its reason and source, and what to do instead.',
    {
      event: {
        type: 'string',
        description: 'a ledger event id; the latest refusal or ask when left out',
      },
      session: SESSION_ARG,
    },
  ),
  readTool(
    'status',
    'Where this machine stands: the mode, what is held, and what happened today.',
  ),
  readTool('replay', 'What this session did, step by step and newest last, compact.', {
    session: SESSION_ARG,
  }),
  readTool(
    'decisions',
    'The rules and remembered decisions that cover an action or a path. Evaluates only; runs nothing.',
    {
      action: {
        type: 'string',
        description: 'a command such as "git push --force", or a verb such as "git.push"',
      },
      path: { type: 'string', description: 'a file or directory the action touches' },
    },
  ),
  {
    name: 'rewind',
    description:
      'Put the working tree back to before the last session changed it, or to a milestone. Your person must approve it; the current files are kept first.',
    inputSchema: {
      type: 'object',
      properties: {
        milestone: {
          type: 'string',
          description: 'a milestone id from "memnox rewind --list"',
        },
        session: {
          type: 'string',
          description: 'rewind to before this session; the newest one when left out',
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
];

/** Answers one call by name, or null for a name this server never offered. */
export async function callTool(
  deps: SessionToolDeps,
  seams: RewindSeams,
  name: string,
  args: ToolArgs,
): Promise<unknown> {
  switch (name) {
    case 'why':
      return whyTool(deps, args);
    case 'status':
      return statusTool(deps);
    case 'replay':
      return replayTool(deps, args);
    case 'decisions':
      return decisionsTool(deps, args);
    case 'rewind':
      return rewindTool(deps, seams, args);
    default:
      return null;
  }
}
