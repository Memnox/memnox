/**
 * An agent's own tool result read for text addressing the model: a page, a README, a
 * command's output. The proxy does this for MCP; this is the same check for the rest.
 */
import { hasInstructionShape } from '@memnox/core';

import { EDIT_HOOK_EVENT } from './edit-hook';
import type { HookAuthorizer } from './hook-authorizer';
import { fieldsOf } from './hook-payload';

/** Enough to find an instruction, and bounded, since a response can be a whole file. */
const MOST_CHARS_READ = 200_000;

/** Nested structure is walked this deep and no deeper. */
const MOST_DEPTH = 4;

/** Memnox's own tools answer about the session, so they are never the source of a taint. */
const OWN_TOOL = /^mcp__memnox/;

/** The text a response carries, from a string or the strings inside an object. */
export function responseText(response: unknown, depth = 0): string {
  if (typeof response === 'string') return response.slice(0, MOST_CHARS_READ);
  if (depth >= MOST_DEPTH || typeof response !== 'object' || response === null) return '';
  const values = Array.isArray(response) ? response : Object.values(response);
  let text = '';
  for (const value of values) {
    text += `${responseText(value, depth + 1)}\n`;
    if (text.length >= MOST_CHARS_READ) break;
  }
  return text.slice(0, MOST_CHARS_READ);
}

/**
 * Marks the session when a tool's result read like instructions. True when it did. Only
 * after a tool ran, since before it nothing has been read.
 */
export function taintFromResult(payload: unknown, authorizer: HookAuthorizer): boolean {
  const hook = fieldsOf(payload);
  if (hook === null || hook['hook_event_name'] !== EDIT_HOOK_EVENT.POST_TOOL_USE)
    return false;
  const tool = hook['tool_name'];
  if (typeof tool !== 'string' || OWN_TOOL.test(tool)) return false;
  if (!hasInstructionShape(responseText(hook['tool_response']))) return false;
  return authorizer.taint(tool);
}
