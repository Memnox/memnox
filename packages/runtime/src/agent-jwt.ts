import { createHmac, timingSafeEqual } from 'node:crypto';

const JWT_PARTS = 3;
const JWT_ALG = 'HS256';

export interface AgentJwtConfig {
  /** HS256 shared secret the token issuer signs with. */
  secret: string;
  /** When set, tokens from other issuers are rejected. */
  issuer?: string;
}

/**
 * Service-account style agent auth: an identity provider issues short-lived
 * HS256 JWTs whose `sub` is the registered agent ID. Verified locally —
 * no network in the decision path.
 */
export function verifyAgentJwt(token: string, config: AgentJwtConfig): string | null {
  const parts = token.split('.');
  if (parts.length !== JWT_PARTS) return null;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  const expected = createHmac('sha256', config.secret)
    .update(`${headerPart}.${payloadPart}`)
    .digest('base64url');
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signaturePart);
  if (expectedBuffer.length !== actualBuffer.length) return null;
  if (!timingSafeEqual(expectedBuffer, actualBuffer)) return null;

  let header: { alg?: string };
  let payload: { sub?: string; iss?: string; exp?: number };
  try {
    header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (header.alg !== JWT_ALG) return null;
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null;
  if (config.issuer && payload.iss !== config.issuer) return null;
  if (typeof payload.exp === 'number' && payload.exp * 1_000 <= Date.now()) return null;
  return payload.sub;
}

/** Test/issuer helper — mints an HS256 agent JWT. */
export function signAgentJwt(
  agentId: string,
  config: AgentJwtConfig,
  ttlSeconds: number,
): string {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: JWT_ALG, typ: 'JWT' });
  const payload = encode({
    sub: agentId,
    iss: config.issuer,
    exp: Math.floor(Date.now() / 1_000) + ttlSeconds,
  });
  const signature = createHmac('sha256', config.secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}
