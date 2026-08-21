/** Loopback only: a routable bind would put an unauthenticated rule editor on the network. */
export const POLICY_UI_HOST = '127.0.0.1';

export const DEFAULT_POLICY_UI_PORT = 7391;

/** A browser resolving an attacker's hostname to 127.0.0.1 still sends that name. */
export const ALLOWED_UI_HOSTNAMES: readonly string[] = ['127.0.0.1', 'localhost', '::1'];

/** A custom header cannot be sent by a drive-by form post. */
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
