/** Where one capability came from, as a chain back to the config that granted it. */

import { classifyActionClass, type CapabilityTrace } from '@memnox/core';
import type { CliContext } from '../../cli-context';

/** Every field is read off a scan, so the chain is evidence rather than a guess. */
export function renderTrace(context: CliContext, trace: CapabilityTrace): void {
  const { flow } = context;
  flow.rows(trace.tool, [
    { label: 'server', value: trace.server },
    { label: 'declared', value: trace.grantedBy },
    {
      label: 'class',
      value: `${trace.effect}, ${classifyActionClass(trace.tool).class}`,
    },
    {
      label: 'reached by',
      value:
        trace.reachedBy.length === 0
          ? 'no agent here launches it'
          : trace.reachedBy.join(', '),
    },
    {
      label: 'first seen',
      value: trace.firstSeen ?? 'at least as long as the kept scans go back',
    },
  ]);
  flow.close(`${trace.tool} comes from ${trace.server}.`);
}
