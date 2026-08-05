/** Loopback only: a routable bind would put an unauthenticated rule editor on the network. */
export const POLICY_UI_HOST = '127.0.0.1';

export const DEFAULT_POLICY_UI_PORT = 7391;

/**
 * The only names the page may be reached under. A browser that resolved some
 * attacker-controlled hostname to 127.0.0.1 arrives with that name in `Host`,
 * so checking it is what stops a rebound DNS record from driving the editor.
 */
export const ALLOWED_UI_HOSTNAMES: readonly string[] = ['127.0.0.1', 'localhost', '::1'];

/**
 * Minted per run and echoed by the page. A custom header cannot be sent by a
 * drive-by form post, and no CORS headers are served, so a page on another
 * origin can neither read from nor write to this server.
 */
export const UI_SESSION_HEADER = 'x-memnox-ui-token';
export const UI_SESSION_TOKEN_BYTES = 32;

/** Big enough for a real rule set, small enough that a stray upload cannot exhaust memory. */
export const MAX_REQUEST_BYTES = 2_000_000;

/** Audit events replayed when the simulate panel asks a running runtime. */
export const SIMULATION_SAMPLE = 500;

export const UI_PATH = {
  PAGE: '/',
  DOCUMENT: '/api/document',
  PACK: '/api/pack',
  VALIDATE: '/api/validate',
  SAVE: '/api/save',
  SIMULATE: '/api/simulate',
} as const;

export const CONTENT_TYPE = {
  HTML: 'text/html; charset=utf-8',
  JSON: 'application/json; charset=utf-8',
  TEXT: 'text/plain; charset=utf-8',
} as const;
