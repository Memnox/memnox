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
} as const;

export type ActionName = (typeof ACTION)[keyof typeof ACTION];
