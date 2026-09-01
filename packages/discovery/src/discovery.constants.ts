/** A kind, not a session: Claude Code on four machines is one agent kind. */
export const DISCOVERED_AGENT_KIND = {
  CLAUDE_CODE: 'claude-code',
  CLAUDE_DESKTOP: 'claude-desktop',
  CODEX_CLI: 'codex-cli',
  CURSOR: 'cursor',
  CLINE: 'cline',
  VS_CODE: 'vscode',
  GITHUB_ACTIONS: 'github-actions',
} as const;

export type DiscoveredAgentKind =
  (typeof DISCOVERED_AGENT_KIND)[keyof typeof DISCOVERED_AGENT_KIND];

/** What an agent can act through. Each is a seam Memnox can hold, or admit it cannot. */
export const SURFACE_KIND = {
  SHELL: 'shell',
  FILESYSTEM: 'filesystem',
  GIT: 'git',
  MCP: 'mcp',
  NETWORK: 'network',
  DOCKER: 'docker',
  CLOUD: 'cloud',
  BROWSER: 'browser',
} as const;

export type SurfaceKind = (typeof SURFACE_KIND)[keyof typeof SURFACE_KIND];

/**
 * A shell short-circuits reachability: an agent that can run one reaches everything
 * the user reaches, and stating that plainly is most of the value of the map.
 */
export const TRANSITIVE_SURFACES: readonly SurfaceKind[] = [SURFACE_KIND.SHELL];

export const RESOURCE_KIND = {
  FILE: 'file',
  SECRET: 'secret',
  REPO: 'repo',
  DB: 'db',
  CLOUD: 'cloud',
  SOCKET: 'socket',
  /** Not a file: what an agent with a shell or an HTTP tool can already reach. */
  NETWORK: 'network',
} as const;

export type ResourceKind = (typeof RESOURCE_KIND)[keyof typeof RESOURCE_KIND];

/** What one MCP tool does, which no client shows anywhere. */
export const TOOL_EFFECT = {
  READ: 'read',
  WRITE: 'write',
  DESTRUCTIVE: 'destructive',
  UNKNOWN: 'unknown',
} as const;

export type ToolEffect = (typeof TOOL_EFFECT)[keyof typeof TOOL_EFFECT];

/** How the effect was arrived at, stated so a wrong guess is arguable. */
export const EFFECT_INFERENCE = {
  ANNOTATION: 'annotation',
  SCHEMA: 'schema',
  NAME: 'name',
  PROBE: 'probe',
} as const;

export type EffectInference = (typeof EFFECT_INFERENCE)[keyof typeof EFFECT_INFERENCE];

export const SENSITIVITY = {
  ORDINARY: 'ordinary',
  SENSITIVE: 'sensitive',
  CRITICAL: 'critical',
} as const;

export type Sensitivity = (typeof SENSITIVITY)[keyof typeof SENSITIVITY];

export const SENSITIVITY_ORDER: Record<Sensitivity, number> = {
  [SENSITIVITY.ORDINARY]: 0,
  [SENSITIVITY.SENSITIVE]: 1,
  [SENSITIVITY.CRITICAL]: 2,
};

export const FINDING_SEVERITY = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
} as const;

export type FindingSeverity = (typeof FINDING_SEVERITY)[keyof typeof FINDING_SEVERITY];

export const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  [FINDING_SEVERITY.LOW]: 0,
  [FINDING_SEVERITY.MEDIUM]: 1,
  [FINDING_SEVERITY.HIGH]: 2,
  [FINDING_SEVERITY.CRITICAL]: 3,
};

/** Where a harden step lands. Never in a file the reader's team reviews. */
export const HARDEN_TARGET = {
  POLICY: 'policy',
  SEAM: 'seam',
} as const;

export type HardenTarget = (typeof HARDEN_TARGET)[keyof typeof HARDEN_TARGET];

/**
 * Anything ambiguous defaults to advise. Breaking somebody's work at 2am is the one
 * failure this product does not recover from.
 */
export const HARDEN_MODE = {
  ADVISE: 'advise',
  ENFORCE: 'enforce',
} as const;

export type HardenMode = (typeof HARDEN_MODE)[keyof typeof HARDEN_MODE];

/** A fingerprint, never the value. The reader holds the secret; nothing downstream does. */
export const FINGERPRINT_ALGORITHM = 'sha256';
export const FINGERPRINT_LENGTH = 16;

/**
 * Bounded because this is the one place discovery starts somebody else's process.
 * A server that will not answer in this long is a gap in the report, not a stall.
 */
export const MCP_PROBE_TIMEOUT_MS = 5_000;

/** The revision the probe negotiates; a server that wants another still answers. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/**
 * Command-line tools an agent with a shell can invoke. Detected by looking where they
 * install, because a name on a list nobody checked is a claim rather than a finding.
 */
export const KNOWN_TOOLS: readonly { name: string; paths: readonly string[] }[] = [
  { name: 'git', paths: ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git'] },
  {
    name: 'docker',
    paths: ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/usr/bin/docker'],
  },
  {
    name: 'kubectl',
    paths: ['/usr/local/bin/kubectl', '/opt/homebrew/bin/kubectl', '/usr/bin/kubectl'],
  },
  { name: 'aws', paths: ['/usr/local/bin/aws', '/opt/homebrew/bin/aws'] },
  { name: 'gcloud', paths: ['/usr/local/bin/gcloud', '/opt/homebrew/bin/gcloud'] },
  {
    name: 'terraform',
    paths: ['/usr/local/bin/terraform', '/opt/homebrew/bin/terraform'],
  },
  { name: 'psql', paths: ['/usr/local/bin/psql', '/opt/homebrew/bin/psql'] },
];

/**
 * Connection strings worth naming. The scheme and whether it looks like production is
 * all that is kept: the URL itself holds a credential and never leaves the process.
 */
export const DATABASE_SCHEMES: readonly string[] = [
  'postgres',
  'postgresql',
  'mysql',
  'mongodb',
  'redis',
  'mssql',
];

/** Hosts that read as production, so the row can say which one it is. */
export const PRODUCTION_HINTS: readonly string[] = ['prod', 'production', 'live'];
