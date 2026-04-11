import type { ActionEvent, AuditQuery } from '../domain/action-event';
import type { AgentIdentity } from '../domain/agent-identity';
import type { Approval } from '../domain/approval';
import type { ApprovalStatus } from '../constants/approval.constants';
import type { AuditChainVerification } from '../domain/audit-chain';

/** Storage ports — the runtime ships local adapters; any backend can implement these. */

export interface IdentityStore {
  save(agent: AgentIdentity): Promise<void>;
  findById(id: string): Promise<AgentIdentity | null>;
  findByTokenHash(tokenHash: string): Promise<AgentIdentity | null>;
  list(): Promise<AgentIdentity[]>;
}

export interface AuditLog {
  append(event: ActionEvent): Promise<void>;
  recent(limit: number): Promise<ActionEvent[]>;
  /**
   * Chronological events matching the filter — used by replay, reports, and advisors.
   * Callers on the hot path must pass `limit`: an unbounded scan is a scale hazard.
   */
  query(filter: AuditQuery): Promise<ActionEvent[]>;
  /** Retention sweep: drops events older than the cutoff, returns how many. */
  pruneBefore(cutoff: string): Promise<number>;
  /** Walks the hash chain and reports the first broken link. */
  verifyChain(): Promise<AuditChainVerification>;
}

/** Notifies humans that an approval is waiting. Failures must never affect the decision. */
export interface ApprovalNotifier {
  notify(approval: Approval): Promise<void>;
}

export interface ApprovalStore {
  save(approval: Approval): Promise<void>;
  findById(id: string): Promise<Approval | null>;
  findPendingByFingerprint(fingerprint: string): Promise<Approval | null>;
  listByStatus(status: ApprovalStatus): Promise<Approval[]>;
}
