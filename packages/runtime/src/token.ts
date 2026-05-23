import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTE_LENGTH = 32;
const TOKEN_PREFIX = 'mnx_';

export function generateAgentToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTE_LENGTH).toString('hex')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Binds an approval to one exact action so it cannot be replayed for a different one. */
export function fingerprintRequest(
  agentId: string,
  action: string,
  target?: string,
  environment?: string,
): string {
  return createHash('sha256')
    .update([agentId, action, target ?? '', environment ?? ''].join('|'))
    .digest('hex');
}
