/** The ramp, softest first. One environment at a time is the only safe way to arrive. */
export const ENFORCEMENT_MODE = {
  /** No policy evaluation at all — the action proceeds and is audited as ungoverned. */
  OFF: 'off',
  /** Evaluate and record the real verdict, but never withhold the action. */
  OBSERVE: 'observe',
  /** Tell the caller what the verdict was and let it proceed anyway. */
  ADVISE: 'advise',
  /** Apply the verdict. */
  ENFORCE: 'enforce',
} as const;

export type EnforcementMode = (typeof ENFORCEMENT_MODE)[keyof typeof ENFORCEMENT_MODE];

/** Fail-closed: observe-first belongs in a config file, never a library default. */
export const DEFAULT_ENFORCEMENT_MODE: EnforcementMode = ENFORCEMENT_MODE.ENFORCE;

/** Read at its softest wherever one state is drawn for several environments. */
export const MODE_STRENGTH: Record<EnforcementMode, number> = {
  [ENFORCEMENT_MODE.OFF]: 0,
  [ENFORCEMENT_MODE.OBSERVE]: 1,
  [ENFORCEMENT_MODE.ADVISE]: 2,
  [ENFORCEMENT_MODE.ENFORCE]: 3,
};

export const ENFORCEMENT_REASON = {
  DISABLED: 'governance disabled for this environment',
  /** Prefix; the shadow verdict's own reason follows. */
  OBSERVED: 'observed only',
  ADVISED: 'advised only',
} as const;

/** Audited action name for a change to the enforcement mode itself. */
export const ENFORCEMENT_SET_ACTION = 'governance.enforcement';
