/**
 * What the keeper adopts starts on probation: an agent it hooked for the first time, or
 * a server it wrapped, asks before it writes or reaches out until the period ends or a
 * person trusts it. Started here, where the adoption happens, and nowhere else.
 */
import {
  DISCOVERED_AGENT_KIND,
  PROBATION_DAYS,
  PROBATION_KIND,
  ProbationRegister,
  type ProbationStart,
} from '@memnox/core';

/** Where the name a screen prints is not the one the seams speak as. */
const SEAM_AGENT: Readonly<Record<string, string>> = {
  Codex: DISCOVERED_AGENT_KIND.CODEX_CLI,
};

/** One adoption, as the keeper saw it. */
export type Adopted =
  | { kind: typeof PROBATION_KIND.AGENT; agent: string }
  | { kind: typeof PROBATION_KIND.MCP_SERVER; servers: readonly string[] };

/**
 * Starts probation for each thing adopted, and answers the names it was started for.
 * Something that served or was trusted before is not put back on it by a rewritten config.
 */
export async function startProbations(
  home: string,
  adopted: readonly Adopted[],
  now: Date,
): Promise<Set<string>> {
  const register = new ProbationRegister(home);
  const started = new Set<string>();
  for (const start of adopted.flatMap(startsFor)) {
    if ((await register.start(start, now)) !== null)
      started.add(start.label ?? start.name);
  }
  return started;
}

function startsFor(adopted: Adopted): ProbationStart[] {
  if (adopted.kind === PROBATION_KIND.MCP_SERVER) {
    return adopted.servers.map((name) => ({ kind: PROBATION_KIND.MCP_SERVER, name }));
  }
  const name = SEAM_AGENT[adopted.agent] ?? adopted.agent;
  return [{ kind: PROBATION_KIND.AGENT, name, label: adopted.agent }];
}

/** The clause a notice carries, so the person who reads it knows what changed for them. */
export function probationClause(): string {
  return `on probation for ${PROBATION_DAYS} days, so its writes and outward actions ask first`;
}
