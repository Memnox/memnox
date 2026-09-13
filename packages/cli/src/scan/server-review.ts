import { reviewServers, type DiscoveryReport, type ServerReview } from '@memnox/core';
import type { CliContext } from '../cli-context';

/** What one server declares, asks for and can reach — read before it is trusted. */
export function renderServerReview(
  context: CliContext,
  report: DiscoveryReport,
  wanted: string,
  asJson: boolean,
): void {
  const reviews = reviewServers(report);
  const match = reviews.find((review) => review.server === wanted);
  if (match === undefined) {
    const names = reviews.map((review) => review.server);
    throw new Error(
      names.length === 0
        ? `No MCP server is configured on this machine, so there is no "${wanted}" to review.`
        : `No MCP server named "${wanted}". Configured here: ${names.join(', ')}.`,
    );
  }
  if (asJson) {
    context.out.json(match);
    return;
  }
  context.flow.rows(match.server, fieldsFor(match));
  // Zero tools on a server nobody started means unknown, never harmless.
  if (match.unprobed) {
    context.flow.close('This server was never started.');
    context.flow.hint(
      'Its tools are unknown, not absent. Run without --no-probe to ask it.',
    );
    return;
  }
  context.flow.close(`${match.tools} tool(s), ${match.destructive} of them destructive.`);
}

function fieldsFor(review: ServerReview): { label: string; value: string }[] {
  return [
    { label: 'declared in', value: review.declaredIn },
    { label: 'command', value: review.command },
    { label: 'risk', value: review.risk },
    { label: 'tools', value: String(review.tools) },
    { label: 'read', value: String(review.read) },
    { label: 'write', value: String(review.write) },
    { label: 'destructive', value: String(review.destructive) },
    {
      label: 'credentials',
      value: review.credentials.length === 0 ? 'none' : review.credentials.join(', '),
    },
    { label: 'filesystem', value: review.filesystem ? 'reaches it' : 'no' },
    { label: 'network', value: review.network ? 'reaches it' : 'no' },
  ];
}
