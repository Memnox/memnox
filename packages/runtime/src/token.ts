import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTE_LENGTH = 32;
const TOKEN_PREFIX = 'mnx_';

export function generateAgentToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTE_LENGTH).toString('hex')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** What an approval is bound to. Anything absent here is something a grant carries across. */
export interface RequestIdentity {
  agentId: string;
  action: string;
  target?: string;
  environment?: string;
  /** Leaving out the amount let a granted refund of 120 authorize one of 4500. */
  amount?: number;
  /** Whose authority is being drawn on; two people are not interchangeable. */
  principal?: string;
}

/** Length-prefixed, so no field's content can be read as a boundary between two others. */
function encodeField(value: string): string {
  return `${value.length}:${value}`;
}

/** Binds an approval to one exact action so it cannot be replayed for a different one. */
export function fingerprintRequest(identity: RequestIdentity): string {
  return createHash('sha256')
    .update(
      [
        identity.agentId,
        identity.action,
        identity.target ?? '',
        identity.environment ?? '',
        identity.amount === undefined ? '' : String(identity.amount),
        identity.principal ?? '',
      ]
        .map(encodeField)
        .join(''),
    )
    .digest('hex');
}
