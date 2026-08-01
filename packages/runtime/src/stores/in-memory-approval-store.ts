import type { Approval, ApprovalStatus, ApprovalStore } from '@memnox/core';
import { APPROVAL_STATUS, isApprovalPrunable } from '@memnox/core';

export class InMemoryApprovalStore implements ApprovalStore {
  private readonly approvals = new Map<string, Approval>();

  async save(approval: Approval): Promise<void> {
    this.approvals.set(approval.id, approval);
  }

  async findById(id: string): Promise<Approval | null> {
    return this.approvals.get(id) ?? null;
  }

  async findPendingByFingerprint(fingerprint: string): Promise<Approval | null> {
    for (const approval of this.approvals.values()) {
      if (
        approval.requestFingerprint === fingerprint &&
        approval.status === APPROVAL_STATUS.PENDING
      ) {
        return approval;
      }
    }
    return null;
  }

  async listByStatus(status: ApprovalStatus): Promise<Approval[]> {
    return [...this.approvals.values()].filter((approval) => approval.status === status);
  }

  async pruneResolvedBefore(cutoff: string): Promise<number> {
    const stale = [...this.approvals.values()].filter((approval) =>
      isApprovalPrunable(approval, cutoff),
    );
    for (const approval of stale) this.approvals.delete(approval.id);
    return stale.length;
  }
}
