import type { ActionEvent } from '@memnox/core';
import type { SimulationCase } from '@memnox/policy-engine';

/** Real actions make a far better test set than invented ones. */
export function casesFromAudit(events: readonly ActionEvent[]): SimulationCase[] {
  return events.map((event) => ({
    action: event.action,
    ...(event.target ? { target: event.target } : {}),
    ...(event.environment ? { environment: event.environment } : {}),
    ...(event.projectId ? { projectId: event.projectId } : {}),
    agentName: event.agentName,
  }));
}
