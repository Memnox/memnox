export const ENFORCEMENT_MODE = {
  /** No policy evaluation at all — the action proceeds and is audited as ungoverned. */
  OFF: 'off',
  /** Evaluate and record the verdict, but never withhold the action. */
  MONITOR: 'monitor',
  /** Apply the verdict. */
  ENFORCE: 'enforce',
} as const;

export type EnforcementMode = (typeof ENFORCEMENT_MODE)[keyof typeof ENFORCEMENT_MODE];

/**
 * Fail-closed. Monitor-first is an onboarding choice `memnox init` writes into a
 * config file — never a library default, which would silently stop an existing
 * deployment from enforcing the moment it upgrades.
 */
export const DEFAULT_ENFORCEMENT_MODE: EnforcementMode = ENFORCEMENT_MODE.ENFORCE;

export const ENFORCEMENT_REASON = {
  DISABLED: 'governance disabled for this environment',
  /** Prefix; the withheld verdict's own reason follows. */
  OBSERVED: 'observed only',
} as const;
