/**
 * Three classes with three defaults: local usually allows, external state asks or
 * matches a rule, destructive refuses. The line between a draft and an act, drawn
 * where it actually falls rather than where a tool's name puts it.
 */
export const ACTION_CLASS = {
  LOCAL: 'local',
  EXTERNAL_STATE: 'external-state',
  DESTRUCTIVE: 'destructive',
} as const;

export type ActionClass = (typeof ACTION_CLASS)[keyof typeof ACTION_CLASS];

/** What decided the class, stated so a wrong call is arguable rather than mysterious. */
export const CLASS_BASIS = {
  DESTRUCTIVE_VERB: 'destructive-verb',
  OUTWARD: 'outward',
  READ_VERB: 'read-verb',
  LOCAL_NAMESPACE: 'local-namespace',
  /** Nothing proved it local, and an unproven action is not treated as harmless. */
  UNPROVEN: 'unproven',
} as const;

export type ClassBasis = (typeof CLASS_BASIS)[keyof typeof CLASS_BASIS];

/**
 * Namespaces that cannot leave the machine on their own. Everything else is treated
 * as reaching outside it, because an action nothing proved local is not local.
 */
export const LOCAL_NAMESPACES: readonly string[] = [
  'filesystem',
  'file',
  'fs',
  'shell',
  'process',
  'git',
  'editor',
  'test',
  'build',
];

/**
 * Speaking as somebody. Outward communication is external state whatever tool it
 * arrives through and whatever that tool calls itself, because the people receiving
 * it never agreed to hear from an agent.
 */
export const OUTWARD_VERBS: readonly string[] = [
  'send',
  'message',
  'post',
  'publish',
  'notify',
  'email',
  'reply',
  'comment',
  'broadcast',
  'invite',
  'announce',
];

export const OUTWARD_NAMESPACES: readonly string[] = [
  'slack',
  'email',
  'mail',
  'gmail',
  'smtp',
  'sms',
  'twilio',
  'discord',
  'teams',
  'telegram',
  'webhook',
];
