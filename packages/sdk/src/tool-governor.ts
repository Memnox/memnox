import type { ActionRequest } from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';
import type { MemnoxClient } from './client';

/**
 * Every function-calling agent loop — OpenAI Agents SDK, Codex, LangGraph,
 * CrewAI, AutoGen, or a hand-rolled one — reduces to the same shape: a named
 * tool, some arguments, and a function that runs it. Governing that shape once
 * is what makes those frameworks work without an adapter each.
 */
export type ToolHandler<TArgs, TResult> = (args: TArgs) => Promise<TResult>;

export interface GovernedTool<TArgs, TResult> {
  name: string;
  handler: ToolHandler<TArgs, TResult>;
}

/** Turns a tool call into the action event the runtime decides on. */
export type ToolActionMapper<TArgs> = (toolName: string, args: TArgs) => ActionRequest;

export interface ToolGovernorOptions<TArgs> {
  /** Groups an agent run's tool calls into one auditable session. */
  sessionId?: string;
  environment?: string;
  /** Override how a tool call becomes an action; defaults to `tool.<name>`. */
  mapAction?: ToolActionMapper<TArgs>;
  /**
   * Called instead of throwing when the runtime refuses. Returning a value lets
   * the agent read the refusal as a normal tool result and choose a different
   * path, which is usually better than an exception it cannot see.
   */
  onRefused?: (refusal: ToolRefusal) => never | Promise<never>;
}

export interface ToolRefusal {
  toolName: string;
  effect: string;
  reason: string;
  approvalId?: string;
}

const ACTION_TOOL_PREFIX = 'tool.';
const TARGET_MAX_LENGTH = 200;

/** A readable target from arbitrary tool arguments, without leaking a whole payload. */
function describeArgs(args: unknown): string | undefined {
  if (typeof args === 'string') return args.slice(0, TARGET_MAX_LENGTH);
  if (!args || typeof args !== 'object') return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ['path', 'file_path', 'target', 'url', 'command', 'query']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value.slice(0, TARGET_MAX_LENGTH);
    }
  }
  return undefined;
}

function defaultMapper<TArgs>(toolName: string, args: TArgs): ActionRequest {
  return {
    action: `${ACTION_TOOL_PREFIX}${toolName.toLowerCase()}`,
    target: describeArgs(args),
  };
}

export class ToolRefusedError extends Error {
  constructor(public readonly refusal: ToolRefusal) {
    super(`Memnox ${refusal.effect} for "${refusal.toolName}": ${refusal.reason}`);
    this.name = 'ToolRefusedError';
  }
}

/**
 * Wraps one tool handler so the runtime decides before it runs. The wrapped
 * function keeps the original signature, so it drops into any framework that
 * takes a plain async function.
 */
export function governTool<TArgs, TResult>(
  client: MemnoxClient,
  tool: GovernedTool<TArgs, TResult>,
  options: ToolGovernorOptions<TArgs> = {},
): ToolHandler<TArgs, TResult> {
  const mapAction = options.mapAction ?? defaultMapper;

  return async (args: TArgs): Promise<TResult> => {
    const base = mapAction(tool.name, args);
    const decision = await client.check({
      ...base,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.environment ? { environment: options.environment } : {}),
    });

    if (decision.effect !== DECISION_EFFECT.ALLOW) {
      const refusal: ToolRefusal = {
        toolName: tool.name,
        effect: decision.effect,
        reason: decision.reason,
        ...(decision.approvalId ? { approvalId: decision.approvalId } : {}),
      };
      if (options.onRefused) return options.onRefused(refusal);
      throw new ToolRefusedError(refusal);
    }

    return tool.handler(args);
  };
}

/** Wraps a whole tool registry in one call — the usual framework integration point. */
export function governTools<TArgs, TResult>(
  client: MemnoxClient,
  tools: Readonly<Record<string, ToolHandler<TArgs, TResult>>>,
  options: ToolGovernorOptions<TArgs> = {},
): Record<string, ToolHandler<TArgs, TResult>> {
  return Object.fromEntries(
    Object.entries(tools).map(([name, handler]) => [
      name,
      governTool(client, { name, handler }, options),
    ]),
  );
}
