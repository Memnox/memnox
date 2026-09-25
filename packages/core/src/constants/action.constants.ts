/**
 * The action names more than one module spells, since a typo in the join between a seam
 * and a rule is a rule that silently never fires.
 */
export const ACTION = {
  FILESYSTEM_READ: 'filesystem.read',
  FILESYSTEM_WRITE: 'filesystem.write',
  FILESYSTEM_DELETE: 'filesystem.delete',
  SHELL_EXECUTE: 'shell.execute',
  BROWSER_NAVIGATE: 'browser.navigate',
  GIT_PUSH: 'git.push',
  GIT_PUSH_FORCE: 'git.push-force',
  GIT_COMMIT: 'git.commit',
  GIT_MERGE: 'git.merge',
  GIT_RESET: 'git.reset',
  GIT_CLEAN: 'git.clean',
  /** An outbound request through the egress proxy, ruled on by destination and payload. */
  HTTP_REQUEST: 'http.request',
  /** A tunnel through the egress proxy, where only the destination is knowable. */
  HTTP_CONNECT: 'http.connect',
  /** Printing a variable's value, which is how a key leaves without a file being read. */
  ENVIRONMENT_READ: 'environment.read',
} as const;

/** The target of a command that prints every variable at once. */
export const EVERY_VARIABLE = 'all';

export type ActionName = (typeof ACTION)[keyof typeof ACTION];

/** The argument an `http.request` names its method in, so a rule can tell a read from a change. */
export const HTTP_METHOD_ARGUMENT = 'method';

export const HTTP_METHOD = {
  GET: 'GET',
  HEAD: 'HEAD',
  POST: 'POST',
  PUT: 'PUT',
  /** A request whose method nothing could read, such as a tunnel's, which is ruled as a change. */
  UNKNOWN: 'UNKNOWN',
} as const;

/** Methods that only look, so reading documentation or fetching a resource never waits on anybody. */
export const LOOKING_HTTP_METHODS: readonly string[] = [
  HTTP_METHOD.GET,
  HTTP_METHOD.HEAD,
  'OPTIONS',
];

/** Every method that changes something, and one nobody could read, since that might. */
export const CHANGING_HTTP_METHODS: readonly string[] = [
  HTTP_METHOD.POST,
  HTTP_METHOD.PUT,
  'PATCH',
  'DELETE',
  HTTP_METHOD.UNKNOWN,
];
