/** What else one rule governs. The runtime hands policies back as unknown JSON. */
interface PolicyReach {
  actions: string[];
  targets: string[];
  environments: string[];
}

const MATCH_KEY = 'match';
const NAME_KEY = 'name';

/** The reach of a named rule, or null when the runtime did not return it. */
export function policyReach(
  policies: readonly unknown[],
  name: string,
): PolicyReach | null {
  for (const candidate of policies) {
    const record = asRecord(candidate);
    if (record === null || record[NAME_KEY] !== name) continue;
    const match = asRecord(record[MATCH_KEY]);
    if (match === null) return { actions: [], targets: [], environments: [] };
    return {
      actions: patterns(match['actions']),
      targets: patterns(match['targets']),
      environments: patterns(match['environments']),
    };
  }
  return null;
}

/** The reach minus what the reader already asked about, so nothing is echoed back. */
export function reachBeyond(
  reach: PolicyReach,
  request: { action: string; target?: string; environment?: string },
): PolicyReach {
  return {
    actions: reach.actions.filter((pattern) => pattern !== request.action),
    targets: reach.targets.filter((pattern) => pattern !== request.target),
    environments: reach.environments.filter((pattern) => pattern !== request.environment),
  };
}

export function isEmptyReach(reach: PolicyReach): boolean {
  return (
    reach.actions.length === 0 &&
    reach.targets.length === 0 &&
    reach.environments.length === 0
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  return value as Record<string, unknown>;
}

function patterns(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}
