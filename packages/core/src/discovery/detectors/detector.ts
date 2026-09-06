import type { DiscoveredAgent } from '../agent';
import type { MachineReader } from '../ports';
import type { Surface } from '../surface';

export interface DetectionResult {
  agent: DiscoveredAgent;
  surfaces: Surface[];
  /** Set by a harness: the agents it launches, and what it launches them with. */
  hosted?: HostedAgents;
}

/**
 * What a harness runs underneath itself. Named separately from the agent because a
 * harness is one row on the roster and several principals at the seam, and conflating
 * the two is how a swarm gets counted as a single agent.
 */
export interface HostedAgents {
  /** Kinds it drives, as its own config named them. Never inferred from the binary. */
  runtimes: string[];
  /** Roles it defines on disk, e.g. a swarm's planner, coder, deployer. */
  roles: string[];
  /** Hook or worker files it installed into another product's directory. */
  hooks: string[];
  /** True when its config turns on agent-to-agent work across machines. */
  federated: boolean;
  /** The file that proved each of the above, so a harness row is arguable. */
  evidence: string[];
}

/**
 * Discovery reads the home directory; a harness leaves most of its state beside the
 * work. Passed in rather than read, so a detector stays a function of what it was given.
 */
export interface DetectionContext {
  projectDirs: readonly string[];
}

/**
 * One module per product's config layout, versioned separately because those layouts
 * change without notice. A single upstream rename must empty one detector, never the
 * whole screen, so a detector that finds nothing returns nothing and says so.
 */
export interface AgentDetector {
  readonly kind: string;
  /** The layout revision this detector was written against, printed in the report. */
  readonly layoutVersion: string;
  detect(
    reader: MachineReader,
    now: string,
    context?: DetectionContext,
  ): Promise<DetectionResult | null>;
}

export const EMPTY_CONTEXT: DetectionContext = { projectDirs: [] };
