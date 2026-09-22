/**
 * Where a run's agent sends its HTTP: the daemon's egress proxy when one is running, or
 * a proxy of the session's own for as long as the agent lives. An untrusted session
 * always gets its own, since what it may reach is decided for it and not by what it says.
 */
import { LocalGate } from '@memnox/core';
import {
  log,
  proxyUrlFor,
  startEgressProxy,
  type EgressCaller,
  type EgressProxy,
  type EgressProxyOptions,
} from '@memnox/interceptors';
import { daemonEgressPort, egressSeamFor } from '../../daemon/egress';
import { policySetInForce } from '../../policy-path';

/** Loopback is never proxied: a dev server on this machine is not egress. */
const NO_PROXY = 'localhost,127.0.0.1,::1';

/** Every spelling the tools an agent runs read, since curl, git and npm disagree. */
const PROXY_VARIABLES: readonly string[] = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
];

/** Node's own `fetch` reads the proxy variables only when this is set (Node 24 and later). */
const NODE_PROXY_SWITCH = 'NODE_USE_ENV_PROXY';

/** Where the proxy the agent was pointed at came from, as the start screen says it. */
const EGRESS_SOURCE = {
  DAEMON: 'daemon',
  SESSION: 'session',
} as const;

export type EgressSource = (typeof EGRESS_SOURCE)[keyof typeof EGRESS_SOURCE];

export interface SessionEgress {
  url: string;
  port: number;
  source: EgressSource;
  close: () => Promise<void>;
}

/** The variables that point every HTTP client in the agent's tree at the proxy. */
export function proxyEnvironment(url: string): Record<string, string> {
  return {
    ...Object.fromEntries(PROXY_VARIABLES.map((name) => [name, url])),
    NO_PROXY,
    no_proxy: NO_PROXY,
    [NODE_PROXY_SWITCH]: '1',
  };
}

export interface EgressSeams {
  /** The daemon's port, or null when none is running. */
  daemonPort?: (home: string) => Promise<number | null>;
  /** Injected so a test starts nothing that listens. */
  start?: (options: EgressProxyOptions) => Promise<EgressProxy>;
}

interface SessionEgressInput {
  home: string;
  caller: Required<EgressCaller>;
  untrusted: boolean;
  seams?: EgressSeams;
}

/** The daemon's proxy where it can be leaned on, and otherwise one held by this run. */
export async function sessionEgress(input: SessionEgressInput): Promise<SessionEgress> {
  const { home, caller, seams = {} } = input;
  if (!input.untrusted) {
    const port = await (seams.daemonPort ?? daemonEgressPort)(home);
    if (port !== null) {
      return {
        url: proxyUrlFor(port, caller),
        port,
        source: EGRESS_SOURCE.DAEMON,
        close: async () => undefined,
      };
    }
  }
  const set = await policySetInForce(home);
  const gate =
    set.policies.length === 0
      ? undefined
      : new LocalGate(set.policies, { agentName: caller.agent });
  const seam = egressSeamFor({
    home,
    log,
    fixed: caller,
    ...(gate === undefined ? {} : { gate }),
  });
  const proxy = await (seams.start ?? startEgressProxy)({ seam, port: 0, log });
  return {
    url: proxyUrlFor(proxy.port, caller),
    port: proxy.port,
    source: EGRESS_SOURCE.SESSION,
    close: proxy.close,
  };
}
