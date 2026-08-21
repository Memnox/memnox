import type { MemnoxClient } from '@memnox/sdk';
import { describeConnectionFailure } from '../connection';

/** Descriptions are the interface: a model calls a tool from its description alone. */
interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The vocabulary, inline, so a model never has to guess the action name. */
const ACTION_GUIDE =
  'Common actions: file.write, file.read, code.modify, code.delete, shell.execute, ' +
  'deploy.service, database.migrate, database.delete, database.drop, dependency.add, ' +
  'data.export, repository.force_push.';

export const TOOL_RULES = 'memnox_check_rules';
export const TOOL_STATUS = 'memnox_status';

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: TOOL_RULES,
    description:
      'Check what rules your organization has declared about an action, BEFORE you do it. ' +
      'Call this before writing or changing a file, running a shell command, deploying, ' +
      'adding a dependency, or touching a database — especially in an unfamiliar area of ' +
      'the codebase. Returns the constraints that apply, who must approve, and what is ' +
      'blocked outright, in the words the team wrote them. It records nothing and changes ' +
      'nothing: asking is free and always safe. ' +
      ACTION_GUIDE,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: `What you are about to do, as a namespaced verb. ${ACTION_GUIDE}`,
        },
        target: {
          type: 'string',
          description:
            'What it acts on — a file path, table name, service, or the command text.',
        },
        environment: {
          type: 'string',
          description: 'Optional, e.g. "production" or "staging".',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_STATUS,
    description:
      'Check whether Memnox is governing this machine: how many rules are in force, ' +
      'whether it is blocking or only observing, and whether any approvals are waiting ' +
      'on a human. Call this when a tool call was refused and you want to know why, or ' +
      'when the user asks what Memnox is doing.',
    inputSchema: { type: 'object', properties: {} },
  },
];

interface ToolResult {
  text: string;
  isError: boolean;
}

/** What a tool call needs from the outside; injected so tests need no runtime. */
export interface ToolRuntime {
  client: MemnoxClient;
  runtimeUrl: string;
  projectId?: string;
}

const RULES_ARG_MISSING =
  'Which action? Pass "action" — for example {"action":"file.write","target":"src/auth/session.ts"}.';

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  runtime: ToolRuntime,
): Promise<ToolResult> {
  try {
    if (name === TOOL_RULES) return await checkRules(args, runtime);
    if (name === TOOL_STATUS) return await status(runtime);
    return {
      text: `Unknown tool "${name}". Available: ${MCP_TOOLS.map((tool) => tool.name).join(', ')}.`,
      isError: true,
    };
  } catch (err) {
    // A dead runtime is the common failure; say how to fix it rather than
    // surfacing a transport error the model can do nothing with.
    const offline = describeConnectionFailure(err, runtime.runtimeUrl);
    return {
      text:
        offline ??
        `Memnox could not answer: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

async function checkRules(
  args: Record<string, unknown>,
  runtime: ToolRuntime,
): Promise<ToolResult> {
  const action = args['action'];
  if (typeof action !== 'string' || action.length === 0) {
    return { text: RULES_ARG_MISSING, isError: true };
  }
  const target = args['target'];
  const environment = args['environment'];

  const response = await runtime.client.context({
    action,
    ...(typeof target === 'string' ? { target } : {}),
    ...(typeof environment === 'string' ? { environment } : {}),
    ...(runtime.projectId === undefined ? {} : { projectId: runtime.projectId }),
  });
  return { text: response.text, isError: false };
}

async function status(runtime: ToolRuntime): Promise<ToolResult> {
  const [policies, pending] = await Promise.all([
    runtime.client.policies(),
    runtime.client.pendingApprovals(),
  ]);
  const lines = [
    `Memnox is running at ${runtime.runtimeUrl}.`,
    `${policies.policies.length} rule(s) in force (policy version ${policies.version}).`,
    pending.length === 0
      ? 'No approvals are waiting.'
      : `${pending.length} approval(s) waiting on a human:`,
  ];
  for (const approval of pending) {
    const target = approval.target === undefined ? '' : ` ${approval.target}`;
    lines.push(`  - ${approval.action}${target} (ask: ${approval.approvers.join(', ')})`);
  }
  return { text: lines.join('\n'), isError: false };
}
