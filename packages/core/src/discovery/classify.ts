import {
  EFFECT_INFERENCE,
  TOOL_EFFECT,
  type EffectInference,
  type ToolEffect,
} from './discovery.constants';
import { inferToolEffect, nameSegments, type McpToolDeclaration } from './surface';

/**
 * A tool that carries something out of the organization is its own class. It is not
 * destructive — nothing is lost — and calling it a plain write hides the one property
 * that matters: the data has left, and no rule downstream can call it back.
 */
export const TOOL_CLASS = {
  READ: TOOL_EFFECT.READ,
  WRITE: TOOL_EFFECT.WRITE,
  DESTRUCTIVE: TOOL_EFFECT.DESTRUCTIVE,
  COMMUNICATION: 'communication',
  UNKNOWN: TOOL_EFFECT.UNKNOWN,
} as const;

export type ToolClass = (typeof TOOL_CLASS)[keyof typeof TOOL_CLASS];

/** Verbs that move a message to somebody, rather than changing a record. */
const COMMUNICATION_VERBS = [
  'send',
  'post',
  'message',
  'notify',
  'email',
  'mail',
  'chat',
  'reply',
  'comment',
  'announce',
  'broadcast',
  'dm',
];

/** Nouns that make a communication verb unambiguous, so `post_record` stays a write. */
const COMMUNICATION_NOUNS = [
  'message',
  'email',
  'mail',
  'slack',
  'chat',
  'sms',
  'notification',
  'webhook',
  'channel',
  'comment',
];

export interface Classification {
  class: ToolClass;
  /** How it was decided, so a wrong call is arguable rather than mysterious. */
  from: EffectInference | 'override';
}

export type ToolOverrides = Readonly<Record<string, ToolClass>>;

function isToolClass(value: string): value is ToolClass {
  return (Object.values(TOOL_CLASS) as readonly string[]).includes(value);
}

/**
 * Overrides are read from a file people edit by hand, so an unknown class is dropped
 * with the rest kept: refusing the whole file over one typo would leave a machine
 * ungoverned because somebody misspelled a word.
 */
export function parseOverrides(raw: string): {
  overrides: ToolOverrides;
  rejected: string[];
} {
  const overrides: Record<string, ToolClass> = {};
  const rejected: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A file that is not JSON yields no overrides; the caller reports it as unreadable.
    return { overrides: {}, rejected: ['the file is not valid JSON'] };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { overrides: {}, rejected: ['the file is not an object of tool → class'] };
  }
  for (const [tool, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string' && isToolClass(value)) {
      overrides[tool] = value;
      continue;
    }
    rejected.push(
      `${tool}: ${String(value)} is not one of ${Object.values(TOOL_CLASS).join(', ')}`,
    );
  }
  return { overrides, rejected };
}

function looksLikeCommunication(name: string): boolean {
  const segments = nameSegments(name);
  const verb = segments[0];
  if (verb === undefined || !COMMUNICATION_VERBS.includes(verb)) return false;
  // A bare `send` is a message; `post_invoice` is a write with a message-shaped verb.
  const rest = segments.slice(1);
  if (rest.length === 0) return true;
  return COMMUNICATION_NOUNS.some((noun) => rest.some((part) => part.includes(noun)));
}

/**
 * An override wins over everything, including a published annotation: the person who
 * wrote it has seen the tool behave and the server author has not seen this install.
 */
export function classifyTool(
  declaration: McpToolDeclaration,
  overrides: ToolOverrides = {},
): Classification {
  const override = overrides[declaration.name];
  if (override !== undefined) return { class: override, from: 'override' };

  const { effect, inferredFrom } = inferToolEffect(declaration);
  if (
    (effect === TOOL_EFFECT.WRITE || effect === TOOL_EFFECT.UNKNOWN) &&
    looksLikeCommunication(declaration.name)
  ) {
    return { class: TOOL_CLASS.COMMUNICATION, from: EFFECT_INFERENCE.NAME };
  }
  return { class: effect as ToolClass, from: inferredFrom };
}

/** Communication leaves the organization, so it counts with the writes, never the reads. */
export function changesExternalState(classification: ToolClass): boolean {
  return (
    classification === TOOL_CLASS.WRITE ||
    classification === TOOL_CLASS.DESTRUCTIVE ||
    classification === TOOL_CLASS.COMMUNICATION
  );
}
