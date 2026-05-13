/** Copyleft licenses whose obligations most commercial codebases cannot accept. */
export const BLOCKED_LICENSES: readonly string[] = [
  'GPL-2.0',
  'GPL-3.0',
  'AGPL-3.0',
  'SSPL-1.0',
];

/** Weak-copyleft licenses that are usually fine but are a legal call, not an agent's. */
export const REVIEW_LICENSES: readonly string[] = ['LGPL-2.0', 'LGPL-3.0', 'MPL-2.0'];

/** Actions that pull third-party code into the codebase. */
export const DEPENDENCY_ACTIONS: readonly string[] = [
  'dependency.add',
  'package.install',
];

export const DEPENDENCY_SIGNAL = {
  BLOCKED_LICENSE: 'dependency-blocked-license',
  REVIEW_LICENSE: 'dependency-review-license',
  KNOWN_VULNERABILITY: 'dependency-known-vulnerability',
} as const;

/** Registry lookups are opt-in; when enabled they must not hold up a decision. */
export const LICENSE_LOOKUP_TIMEOUT_MS = 3_000;
export const NPM_REGISTRY_URL = 'https://registry.npmjs.org';
