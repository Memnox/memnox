import type { ActionRequest } from '@memnox/core';
import type { HookInput } from './hook-input';

export interface ToolActionSpec {
  /** The namespaced verb a policy is written about, from the existing vocabulary. */
  action: string;
  /** Fields to read the target from, in order. The first present one wins. */
  targetFields: readonly string[];
}

/**
 * One row per tool this seam rules on. The action names what the tool does to the
 * resource, never what kind of file it guesses the resource is: `Edit` writes to a
 * file, and whether that file is code is an inference this seam does not make.
 */
export const TOOL_ACTIONS: Readonly<Record<string, ToolActionSpec>> = {
  Read: { action: 'filesystem.read', targetFields: ['file_path'] },
  Glob: { action: 'filesystem.read', targetFields: ['path', 'pattern'] },
  Grep: { action: 'filesystem.read', targetFields: ['path', 'pattern'] },
  Write: { action: 'file.write', targetFields: ['file_path'] },
  Edit: { action: 'file.write', targetFields: ['file_path'] },
  NotebookEdit: { action: 'file.write', targetFields: ['notebook_path'] },
  Bash: { action: 'shell.execute', targetFields: ['command'] },
  WebFetch: { action: 'http.request', targetFields: ['url'] },
  WebSearch: { action: 'http.request', targetFields: ['query'] },
  Task: { action: 'agent.spawn', targetFields: ['subagent_type', 'description'] },
};

/** Every action glob this seam sees, which is what its coverage entry declares. */
export const HOOK_COVERS: readonly string[] = [
  ...new Set(Object.values(TOOL_ACTIONS).map((spec) => spec.action)),
];

export interface ToolActionOptions {
  /** The governance unit this repository belongs to, resolved by the caller. */
  projectId?: string;
  environment?: string;
}

/**
 * Null means this seam does not rule on the tool — the host's own permission flow is
 * left alone. Silence for the ungoverned is the same rule as silence for the ordinary,
 * and what is not covered is named in HOOK_BLIND_SPOTS rather than left to be inferred.
 */
export function toActionRequest(
  input: HookInput,
  options: ToolActionOptions = {},
): ActionRequest | null {
  const spec = TOOL_ACTIONS[input.toolName];
  if (spec === undefined) return null;

  const target = firstPresent(input.toolInput, spec.targetFields);

  return {
    action: spec.action,
    ...(target === undefined ? {} : { target }),
    // LOCAL ONLY. The SDK strips this before anything reaches the runtime.
    arguments: input.toolInput,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.workingDirectory === undefined
      ? {}
      : { workingDirectory: input.workingDirectory }),
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  };
}

function firstPresent(
  values: Record<string, string>,
  fields: readonly string[],
): string | undefined {
  for (const field of fields) {
    const value = values[field];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}
