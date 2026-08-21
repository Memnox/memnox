import type { FastifyInstance } from 'fastify';

/** The console is the reason: it holds a management token for the tab. */
const BASELINE_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['x-content-type-options', 'nosniff'],
  ['x-frame-options', 'DENY'],
  ['referrer-policy', 'no-referrer'],
  ['cross-origin-opener-policy', 'same-origin'],
  ['cross-origin-resource-policy', 'same-origin'],
];

/** A JSON answer loads nothing and is framed by nobody. The console relaxes this. */
const API_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** The console's own inline script and style by nonce, and nothing else. */
export function consoleCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    // The lockup is a data URI in the document; no remote image is ever loaded.
    'img-src data:',
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onRequest', async (_request, reply) => {
    for (const [name, value] of BASELINE_HEADERS) reply.header(name, value);
    reply.header('content-security-policy', API_CSP);
  });
}
