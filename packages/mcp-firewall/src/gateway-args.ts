import {
  ENV_FAIL_OPEN,
  ENV_RUNTIME_URL,
  ENV_TOOLS_ALLOW,
  ENV_TOOLS_DENY,
} from './firewall.constants';
import {
  DEFAULT_GATEWAY_HOST,
  DEFAULT_GATEWAY_PORT,
  ENV_GATEWAY_HOST,
  ENV_GATEWAY_PORT,
  ENV_UPSTREAM_AUTHORIZATION,
  ENV_UPSTREAM_URL,
} from './gateway.constants';

const NAME_FLAG = '--name';
const DEFAULT_SERVER_NAME = 'mcp-server';
const FAIL_OPEN_VALUE = 'true';

export type GatewayEnv = Readonly<Record<string, string | undefined>>;

export interface GatewayConfig {
  upstreamUrl: string;
  /** Credential for the upstream server, never the caller's Memnox token. */
  authorization: string | undefined;
  serverName: string;
  runtimeUrl: string;
  host: string;
  port: number;
  allowPattern: string | undefined;
  denyPattern: string | undefined;
  failOpen: boolean;
}

/** Null means the invocation cannot run and the caller should print usage. */
export function parseGatewayArgs(
  argv: readonly string[],
  env: GatewayEnv,
): GatewayConfig | null {
  const upstreamUrl = env[ENV_UPSTREAM_URL];
  const runtimeUrl = env[ENV_RUNTIME_URL];
  // Without a runtime there is nothing to gate against, and a gateway that
  // forwards everything is worse than none: it looks like protection.
  if (upstreamUrl === undefined || runtimeUrl === undefined) return null;
  if (upstreamUrl.trim().length === 0 || runtimeUrl.trim().length === 0) return null;

  return {
    upstreamUrl,
    authorization: env[ENV_UPSTREAM_AUTHORIZATION],
    serverName: serverNameFrom(argv),
    runtimeUrl,
    host: env[ENV_GATEWAY_HOST] ?? DEFAULT_GATEWAY_HOST,
    port: portFrom(env[ENV_GATEWAY_PORT]),
    allowPattern: env[ENV_TOOLS_ALLOW],
    denyPattern: env[ENV_TOOLS_DENY],
    failOpen: env[ENV_FAIL_OPEN] === FAIL_OPEN_VALUE,
  };
}

function serverNameFrom(argv: readonly string[]): string {
  const index = argv.indexOf(NAME_FLAG);
  if (index === -1) return DEFAULT_SERVER_NAME;
  const name = argv[index + 1];
  // A flag where the name should be means the name was left off.
  if (name === undefined || name.startsWith('-')) return DEFAULT_SERVER_NAME;
  return name;
}

/** An unusable port falls back to the default rather than binding somewhere unexpected. */
function portFrom(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_GATEWAY_PORT;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 65535) return DEFAULT_GATEWAY_PORT;
  return parsed;
}
