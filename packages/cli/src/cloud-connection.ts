import type { AgentConfig } from './agent-config';

export const ENV_CLOUD_URL = 'MEMNOX_CLOUD_URL';
export const ENV_CLOUD_TOKEN = 'MEMNOX_CLOUD_TOKEN';
export const ENV_CLOUD_WORKSPACE = 'MEMNOX_CLOUD_WORKSPACE';

/** Separate from `token`/`url`: one is the person, the other the machine's agent. */
export interface CloudConfig {
  url: string;
  token: string;
  /** Default workspace, so every command does not need --workspace. */
  workspace?: string;
}

/** What a cloud-backed command was told on the command line. */
export interface CloudFlags {
  cloudUrl?: string;
  cloudToken?: string;
  workspace?: string;
}

export interface ResolvedCloud {
  url: string;
  token: string;
  workspace?: string;
  /** Where the credential came from, so a command can say so instead of looking magic. */
  tokenSource: 'flag' | 'environment' | 'config';
}

/** Nothing to connect to. Named so callers can tell "signed out" from "failed". */
export const CLOUD_NOT_CONFIGURED = 'cloud_not_configured';

export type CloudResolution = ResolvedCloud | typeof CLOUD_NOT_CONFIGURED;

export function isNotConfigured(
  resolution: CloudResolution,
): resolution is typeof CLOUD_NOT_CONFIGURED {
  return resolution === CLOUD_NOT_CONFIGURED;
}

/** The same ladder the runtime connection uses, so one mental model covers both. */
export function resolveCloud(
  flags: CloudFlags,
  stored: AgentConfig,
  env: NodeJS.ProcessEnv,
): CloudResolution {
  const cloud = stored.cloud;
  const envUrl = env[ENV_CLOUD_URL];
  const envToken = env[ENV_CLOUD_TOKEN];

  const url = flags.cloudUrl ?? envUrl ?? (cloud === undefined ? undefined : cloud.url);
  const token =
    flags.cloudToken ?? envToken ?? (cloud === undefined ? undefined : cloud.token);
  // Half a credential cannot reach anything; treat it as signed out rather than
  // failing later with an unauthorized the developer cannot explain.
  if (url === undefined || token === undefined) return CLOUD_NOT_CONFIGURED;

  const workspace =
    flags.workspace ??
    env[ENV_CLOUD_WORKSPACE] ??
    (cloud === undefined ? undefined : cloud.workspace);

  return {
    url: stripTrailingSlash(url),
    token,
    ...(workspace === undefined ? {} : { workspace }),
    tokenSource: sourceOf(flags.cloudToken, envToken),
  };
}

/** The stored URL is joined with paths; a trailing slash would double the separator. */
function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function sourceOf(
  flagToken: string | undefined,
  envToken: string | undefined,
): ResolvedCloud['tokenSource'] {
  if (flagToken !== undefined) return 'flag';
  if (envToken !== undefined) return 'environment';
  return 'config';
}

/** What to tell someone who has not signed in, rather than an unauthorized. */
export const SIGN_IN_HINT =
  'Not signed in to a control plane. Run "memnox login --cloud <url> --token <token>".';

/** Named here so every cloud command words the same failure the same way. */
export const WORKSPACE_HINT =
  'No workspace selected. Pass --workspace <id>, or set a default with "memnox login --workspace <id>".';
