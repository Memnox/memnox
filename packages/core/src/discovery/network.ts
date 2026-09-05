/**
 * What an agent on this machine can reach on the network, read from the environment
 * rather than measured. Nothing here sends a request: a scan that dialled out would
 * be the one command in this product that leaves the machine, and the whole promise
 * is that none of them do.
 */

export const OUTBOUND_STATE = {
  /** Nothing constrains it: an agent with a shell can reach the internet. */
  DETECTED: 'detected',
  /** A proxy or a sandbox stands in the way, so egress is at least observable. */
  RESTRICTED: 'restricted',
  /** Nothing in the environment says either way. Reported as unknown, never as safe. */
  UNKNOWN: 'unknown',
} as const;

export type OutboundState = (typeof OUTBOUND_STATE)[keyof typeof OUTBOUND_STATE];

export interface NetworkProbe {
  outbound: OutboundState;
  /** Proxy variables in force, names only — a proxy URL can carry credentials. */
  proxyVars: string[];
  /** Hosts the environment already exempts from the proxy, which is the real hole. */
  noProxy: string[];
  /** Sandbox indicators found, e.g. a container marker or a seccomp profile. */
  sandbox: string[];
  /** What was read to reach this answer, so the probe is itself inspectable. */
  read: string[];
}

const PROXY_VARS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
] as const;

const NO_PROXY_VARS = ['NO_PROXY', 'no_proxy'] as const;

/** Markers a container or sandbox leaves in the environment of everything it runs. */
const SANDBOX_VARS = [
  'MEMNOX_SANDBOX',
  'CONTAINER',
  'KUBERNETES_SERVICE_HOST',
  'AWS_LAMBDA_FUNCTION_NAME',
] as const;

export interface NetworkProbeInput {
  env: NodeJS.ProcessEnv;
  /** Paths that exist. Passed in, because the probe stays a pure function. */
  present: readonly string[];
}

/** Container markers on disk. Checked by the caller so this stays free of IO. */
export const SANDBOX_PATHS = ['/.dockerenv', '/run/.containerenv'] as const;

export function probeNetwork(input: NetworkProbeInput): NetworkProbe {
  const read: string[] = [];
  const proxyVars: string[] = [];
  for (const name of PROXY_VARS) {
    read.push(`env:${name}`);
    const value = input.env[name];
    if (value !== undefined && value.trim() !== '') proxyVars.push(name);
  }

  const noProxy: string[] = [];
  for (const name of NO_PROXY_VARS) {
    read.push(`env:${name}`);
    const value = input.env[name];
    if (value === undefined) continue;
    for (const host of value.split(',')) {
      const trimmed = host.trim();
      if (trimmed !== '' && !noProxy.includes(trimmed)) noProxy.push(trimmed);
    }
  }

  const sandbox: string[] = [];
  for (const name of SANDBOX_VARS) {
    read.push(`env:${name}`);
    if (input.env[name] !== undefined) sandbox.push(`env:${name}`);
  }
  for (const path of SANDBOX_PATHS) {
    read.push(path);
    if (input.present.includes(path)) sandbox.push(path);
  }

  return {
    outbound: outboundState(proxyVars, sandbox),
    proxyVars,
    noProxy,
    sandbox,
    read,
  };
}

/**
 * A proxy that exempts everything is not a restriction, and reporting it as one would
 * be the reassurance this product must never give.
 */
function outboundState(
  proxyVars: readonly string[],
  sandbox: readonly string[],
): OutboundState {
  if (proxyVars.length > 0 || sandbox.length > 0) return OUTBOUND_STATE.RESTRICTED;
  return OUTBOUND_STATE.UNKNOWN;
}

/** Wildcards that exempt every host, which turns a proxy into decoration. */
const TOTAL_EXEMPTIONS = ['*', '.*'];

export function proxyIsBypassedEntirely(probe: NetworkProbe): boolean {
  return probe.noProxy.some((host) => TOTAL_EXEMPTIONS.includes(host));
}

export function describeNetwork(probe: NetworkProbe): string {
  if (probe.outbound === OUTBOUND_STATE.UNKNOWN) {
    return 'nothing here restricts outbound traffic, and nothing here proves it is open';
  }
  if (proxyIsBypassedEntirely(probe)) {
    return 'a proxy is set but exempts every host, so it restricts nothing';
  }
  const parts: string[] = [];
  if (probe.proxyVars.length > 0) parts.push(`proxy via ${probe.proxyVars.join(', ')}`);
  if (probe.sandbox.length > 0) parts.push(`sandboxed (${probe.sandbox.join(', ')})`);
  return parts.join('; ');
}
