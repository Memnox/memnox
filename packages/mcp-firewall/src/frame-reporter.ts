import type { MemnoxClient } from '@memnox/sdk';
import type { McpCallRecord } from './result-guard';

/** The ledger's own vocabulary; declared here so this package keeps its two deps. */
const FRAME_TOOL_CALL = 'tool_call';
const FRAME_RESULT = 'result';

export interface FrameReporterDeps {
  client: MemnoxClient;
  sessionId: string;
  log: (message: string) => void;
}

/**
 * Every call and result reaches the ledger with the arguments hashed, so a session can
 * be replayed without storing what was in it. Reporting is fire-and-forget on purpose:
 * a ledger that is briefly unreachable must never hold up a tool call.
 */
export class FrameReporter {
  constructor(private readonly deps: FrameReporterDeps) {}

  report(record: McpCallRecord): void {
    const result = record.result;
    // The outbound record carries no result; the inbound one carries only the result.
    // Emitting both from either would double every call in the timeline.
    if (result === undefined) {
      this.send({
        kind: FRAME_TOOL_CALL,
        summary: `${record.server}.${record.tool}`,
        payloadDigest: record.argsDigest,
        ...(record.decisionId === undefined ? {} : { decisionId: record.decisionId }),
      });
      return;
    }
    this.send({
      kind: FRAME_RESULT,
      // Instruction-shaped content is recorded rather than removed, so the frame says so.
      summary: `${record.server}.${record.tool} returned ${result.bytes} bytes${
        result.containsInstruction ? ', instruction-shaped, quoted not obeyed' : ''
      }`,
      ...(record.decisionId === undefined ? {} : { decisionId: record.decisionId }),
    });
  }

  private send(frame: {
    kind: string;
    summary: string;
    decisionId?: string;
    payloadDigest?: string;
  }): void {
    void this.deps.client
      .reportFrame({ sessionId: this.deps.sessionId, ...frame })
      .catch((err: unknown) => {
        this.deps.log(`frame not recorded: ${String(err)}`);
      });
  }
}
