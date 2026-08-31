/**
 * The places an organization's information already lives. A workspace connects many of
 * them, of different kinds, and each is scoped to named parts rather than to all of it.
 */
export const SOURCE_KIND = {
  SLACK: 'slack',
  GITHUB: 'github',
  LINEAR: 'linear',
  JIRA: 'jira',
  NOTION: 'notion',
  CONFLUENCE: 'confluence',
  GOOGLE_DRIVE: 'google_drive',
  /** A system nobody wrote a connector for; a person entered what it says. */
  MANUAL: 'manual',
} as const;

export type SourceKind = (typeof SOURCE_KIND)[keyof typeof SOURCE_KIND];

/**
 * A source outlives its connection. Losing access must not throw away what somebody
 * chose to read, so `disconnected` keeps the scope and stops the reading.
 */
export const SOURCE_STATUS = {
  CONNECTED: 'connected',
  /** Credentials gone or revoked. The scope survives; nothing is read. */
  DISCONNECTED: 'disconnected',
  /** A person turned it off deliberately. */
  PAUSED: 'paused',
} as const;

export type SourceStatus = (typeof SOURCE_STATUS)[keyof typeof SOURCE_STATUS];

/** How two records were decided to be the same thing. */
export const RESOLUTION_BASIS = {
  /** Same system, same id there. The only merge that is certain. */
  EXTERNAL_REF: 'external_ref',
  /** Different systems, normalised identity agreed. A person may need to split it. */
  IDENTITY: 'identity',
} as const;

export type ResolutionBasis = (typeof RESOLUTION_BASIS)[keyof typeof RESOLUTION_BASIS];

/**
 * An understanding refreshed by hand is wrong by Thursday, so a connected source is
 * read on a schedule rather than on import.
 */
export const DEFAULT_REFRESH_MINUTES = 60;

/** A bound per run, so one noisy source cannot fill a review queue nobody reads. */
export const MAX_DOCUMENTS_PER_RUN = 500;

/**
 * Isolation between organizations. Shared is the default and is enforced at the
 * storage port rather than by a filter each caller remembers to add; dedicated gives
 * an enterprise tenant its own database, and a region it does not leave.
 */
export const TENANT_ISOLATION = {
  SHARED: 'shared',
  DEDICATED: 'dedicated',
} as const;

export type TenantIsolation = (typeof TENANT_ISOLATION)[keyof typeof TENANT_ISOLATION];
