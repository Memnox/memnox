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

/**
 * Storage only: an adapter never applies the approval TTL, because whether a
 * hold still counts is `ApprovalService`'s call and the flow report has to see
 * the lapsed ones. Adapters that filtered on their own disagreed with each other.
 */
export interface ApprovalStore {
  save(approval: Approval): Promise<void>;
  findById(id: string): Promise<Approval | null>;
  findPendingByFingerprint(fingerprint: string): Promise<Approval | null>;
  /**
   * The unspent grant for this exact action, if a human has already given one.
   * This is how an approval reaches a caller that cannot echo an approval id
   * back — an editor hook builds its request from a tool call and has nowhere
   * to put one, so without this lookup an approved action retries forever.
   */
  findGrantedByFingerprint(fingerprint: string): Promise<Approval | null>;
  listByStatus(status: ApprovalStatus): Promise<Approval[]>;
  /**
   * Retention sweep. Drops approvals raised before the cutoff that have reached
   * a terminal status, returns how many. A pending hold is never dropped: it is
   * a human decision still owed, however old it looks.
   */
  pruneResolvedBefore(cutoff: string): Promise<number>;
}
