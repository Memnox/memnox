import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Approval, ApprovalStatus, ApprovalStore, TextCodec } from '@memnox/core';
import { APPROVAL_STATUS, PLAIN_TEXT_CODEC } from '@memnox/core';

/**
 * Approvals survive restarts — a pending human decision must not vanish with the
 * process. TTL is not applied here: an adapter is storage, and ApprovalService
 * owns expiry so every backend answers the same way.
 */
export class JsonFileApprovalStore implements ApprovalStore {
  private approvals = new Map<string, Approval>();
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly codec: TextCodec = PLAIN_TEXT_CODEC,
  ) {}

  async save(approval: Approval): Promise<void> {
    await this.ensureLoaded();
    this.approvals.set(approval.id, approval);
    await this.persist();
  }

  async findById(id: string): Promise<Approval | null> {
    await this.ensureLoaded();
    return this.approvals.get(id) ?? null;
  }

  async findPendingByFingerprint(fingerprint: string): Promise<Approval | null> {
    await this.ensureLoaded();
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
    await this.ensureLoaded();
    return [...this.approvals.values()].filter((approval) => approval.status === status);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(
        this.codec.decode(await readFile(this.filePath, 'utf8')),
      ) as Approval[];
      this.approvals = new Map(parsed.map((approval) => [approval.id, approval]));
    } catch {
      // First run — file does not exist yet.
      this.approvals = new Map();
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      this.codec.encode(JSON.stringify([...this.approvals.values()], null, 2)),
      'utf8',
    );
  }
}
