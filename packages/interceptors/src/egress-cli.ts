import { homedir } from 'node:os';

import { DestinationRecords, EXIT, openLedger } from '@memnox/core';

import { EGRESS_BLIND_SPOTS, EgressSeam } from './egress-seam';
import { EGRESS_LOOPBACK, recordEgress, startEgressProxy } from './egress-server';
import { buildAuthorizer, buildHold, log } from './seam-runtime';
import { EGRESS_DEFAULT_PORT } from './tool-hook.constants';

/**
 * The egress proxy as a process, for a machine with no daemon: a local HTTP and CONNECT
 * proxy an agent is pointed at through `HTTP_PROXY`. The daemon runs the same server.
 */

const USAGE = `Usage: memnox-egress [--port <port>]

An HTTP forward proxy that rules on what leaves this machine. The daemon runs one for
you; this is the same proxy for a machine without it. Point an agent at it:

  HTTP_PROXY=http://${EGRESS_LOOPBACK}:${EGRESS_DEFAULT_PORT} HTTPS_PROXY=http://${EGRESS_LOOPBACK}:${EGRESS_DEFAULT_PORT} <your agent>

Blind to:
${EGRESS_BLIND_SPOTS.map((spot) => `  ${spot}`).join('\n')}`;

/** The highest port a TCP socket can bind, so anything above it is a typo. */
const MAX_PORT = 65_535;

function portFrom(argv: readonly string[]): number | null {
  const index = argv.indexOf('--port');
  if (index === -1) return EGRESS_DEFAULT_PORT;
  const raw = argv[index + 1];
  if (raw === undefined) return null;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port <= MAX_PORT ? port : null;
}

async function main(): Promise<void> {
  const port = portFrom(process.argv.slice(2));
  if (port === null) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = EXIT.FAILED;
    return;
  }

  const home = homedir();
  const seam = new EgressSeam({
    authorizer: await buildAuthorizer(),
    // An ask on the network seam has to reach a person, or `ask` is a slower `deny`.
    hold: buildHold(),
    ruled: recordEgress(openLedger(home), new DestinationRecords(home)),
  });
  const proxy = await startEgressProxy({ seam, port, log });
  log(`egress seam on ${EGRESS_LOOPBACK}:${proxy.port}`);
  // A blind spot nobody reads is a blind spot nobody has.
  for (const spot of EGRESS_BLIND_SPOTS) log(`blind to: ${spot}`);
}

main().catch((err: unknown) => {
  log(`egress seam failed to start, ruling on nothing: ${String(err)}`);
  process.exitCode = EXIT.FAILED;
});
