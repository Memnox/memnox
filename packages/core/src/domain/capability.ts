/**
 * What an action does, finer than read or write: whether a change moves money, puts
 * something in front of users, hands out authority, runs code, deletes, or speaks for
 * somebody. Derived from the action's name and class, the same way on every seam.
 */
import { LOCAL_NAMESPACES } from '../constants/action-class.constants';
import { nameSegments } from '../discovery/surface';

export const CAPABILITY = {
  READ: 'read',
  WRITE: 'write',
  DELETE: 'delete',
  SEND: 'send',
  EXECUTE: 'execute',
  ADMIN: 'admin',
  DEPLOY: 'deploy',
  TRANSFER: 'transfer',
  UNKNOWN: 'unknown',
} as const;

export type Capability = (typeof CAPABILITY)[keyof typeof CAPABILITY];

/** Words that move money outright, whatever tool says them. */
const TRANSFER_WORDS = [
  'refund',
  'refunds',
  'payout',
  'payouts',
  'transfer',
  'transfers',
];
/** Words that move money when the thing named is a payment. */
const PAYMENT_WORDS = ['capture', 'confirm', 'pay', 'charge', 'charges'];
const PAYMENT_NOUNS = [
  'payment',
  'payments',
  'intents',
  'invoice',
  'invoices',
  'charge',
  'charges',
];
const DEPLOY_WORDS = [
  'deploy',
  'redeploy',
  'up',
  'publish',
  'release',
  'rollout',
  'rollback',
  'promote',
  'apply',
];
const ADMIN_WORDS = [
  'iam',
  'role',
  'roles',
  'permission',
  'permissions',
  'grant',
  'revoke',
  'invite',
  'member',
  'members',
  'owner',
  'access',
  'secret',
  'token',
];
const EXECUTE_WORDS = [
  'exec',
  'execute',
  'run',
  'ssh',
  'shell',
  'connect',
  'invoke',
  'debug',
  'attach',
];

const BY_CLASS: Readonly<Record<string, Capability>> = {
  read: CAPABILITY.READ,
  write: CAPABILITY.WRITE,
  destructive: CAPABILITY.DELETE,
  communication: CAPABILITY.SEND,
};

/**
 * A read is a read however it is named. A change is named by the most consequential
 * thing its words say, money first, and otherwise by its class.
 */
export function capabilityOf(action: string, toolClass: string | undefined): Capability {
  if (toolClass === CAPABILITY.READ) return CAPABILITY.READ;
  const byClass = BY_CLASS[toolClass ?? ''] ?? CAPABILITY.UNKNOWN;
  if (byClass === CAPABILITY.UNKNOWN) return CAPABILITY.UNKNOWN;
  // `git apply` patches a file here; deploy, money and authority are about somewhere else.
  if (LOCAL_NAMESPACES.includes(action.split('.')[0] ?? '')) return byClass;
  const words = nameSegments(action.replace(/\./g, '_'));
  if (
    hasAny(words, TRANSFER_WORDS) ||
    (hasAny(words, PAYMENT_WORDS) && hasAny(words, PAYMENT_NOUNS))
  ) {
    return CAPABILITY.TRANSFER;
  }
  if (hasAny(words, DEPLOY_WORDS)) return CAPABILITY.DEPLOY;
  if (hasAny(words, ADMIN_WORDS)) return CAPABILITY.ADMIN;
  // A delete keeps its name: that nothing comes back is what matters about it.
  if (byClass === CAPABILITY.DELETE) return CAPABILITY.DELETE;
  if (hasAny(words, EXECUTE_WORDS)) return CAPABILITY.EXECUTE;
  return byClass;
}

function hasAny(words: readonly string[], list: readonly string[]): boolean {
  return words.some((word) => list.includes(word));
}
