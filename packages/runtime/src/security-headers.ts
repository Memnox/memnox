import type { FastifyInstance } from 'fastify';

/** The runtime answers JSON to programs, so every one of these can be absolute. */
const BASELINE_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['x-content-type-options', 'nosniff'],
  ['x-frame-options', 'DENY'],
  ['referrer-policy', 'no-referrer'],
  ['cross-origin-opener-policy', 'same-origin'],
  ['cross-origin-resource-policy', 'same-origin'],
];

/** A JSON answer loads nothing and is framed by nobody. */
const API_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onRequest', async (_request, reply) => {
    for (const [name, value] of BASELINE_HEADERS) reply.header(name, value);
    reply.header('content-security-policy', API_CSP);
  });
}
