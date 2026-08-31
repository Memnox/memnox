import type { DiscoveredAgent } from '../agent';
import type { MachineReader } from '../ports';
import type { Surface } from '../surface';

export interface DetectionResult {
  agent: DiscoveredAgent;
  surfaces: Surface[];
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
  detect(reader: MachineReader, now: string): Promise<DetectionResult | null>;
}
