import type { ActionEvent, Logger } from '@memnox/core';
import {
  assembleLineage,
  lineageConfidence,
  LINEAGE_METHOD,
  type FrameStore,
  type HopObservation,
  type Lineage,
} from '@memnox/ledger';

export interface LineageServiceDeps {
  /** Every audited action in one session, which is where the actors come from. */
  events: (sessionId: string) => Promise<ActionEvent[]>;
  frames?: FrameStore;
  logger: Logger;
}

export interface LineageReport {
  lineage: Lineage;
  /** A chain is only as good as its weakest hop, and saying so is the honest report. */
  confidence: number;
  /** What could not be joined, named rather than left as a silent gap. */
  unjoined: string[];
}

/**
 * Who caused this. Within one session the id was carried on every request, so those
 * hops are propagated; a frame that arrived with no decision behind it was joined on
 * actor and time alone, and says so. An inferred hop pretending to be a propagated one
 * is worse than a gap.
 */
export class LineageService {
  constructor(private readonly deps: LineageServiceDeps) {}

  async forSession(sessionId: string): Promise<LineageReport> {
    const observations: HopObservation[] = [];
    const unjoined: string[] = [];

    for (const event of await this.deps.events(sessionId)) {
      observations.push({
        at: event.occurredAt,
        actorId: event.agentId,
        actorKind: 'agent',
        system: event.action,
        correlationId: sessionId,
        // The session id rode on the request and was read back off the record.
        method: LINEAGE_METHOD.PROPAGATED,
        ...(event.target === undefined ? {} : { ref: event.target }),
      });
    }

    for (const frame of await this.framesFor(sessionId)) {
      // A frame with a decision behind it is already covered by that decision's hop.
      if (frame.decisionId !== undefined) continue;
      observations.push({
        at: frame.at,
        actorId: frame.agentId,
        actorKind: 'seam',
        system: frame.kind,
        correlationId: sessionId,
        // Nothing named a verdict, so actor and time are all that joined it.
        method: LINEAGE_METHOD.INFERRED,
      });
      unjoined.push(`${frame.kind}: ${frame.summary}`);
    }

    const lineage = assembleLineage(sessionId, observations);
    return { lineage, confidence: lineageConfidence(lineage), unjoined };
  }

  private async framesFor(
    sessionId: string,
  ): Promise<Awaited<ReturnType<FrameStore['bySession']>>> {
    const frames = this.deps.frames;
    if (frames === undefined) return [];
    try {
      return await frames.bySession(sessionId);
    } catch (err) {
      // A missing timeline narrows the chain; it must not lose the decisions too.
      this.deps.logger.error(`frames unreadable for ${sessionId}: ${String(err)}`);
      return [];
    }
  }
}
