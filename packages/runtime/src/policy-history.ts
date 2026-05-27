import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Policy } from '@memnox/policy-engine';
import { versionPolicySet } from '@memnox/policy-engine';

const HISTORY_FILE = 'policy-history.json';
/** Enough to roll back through a bad afternoon without unbounded growth. */
export const MAX_HISTORY_ENTRIES = 50;

export interface PolicyVersionRecord {
  /** Content hash of the rule set — the same identity the audit log stamps. */
  version: string;
  policyCount: number;
  policyNames: string[];
  publishedAt: string;
  /** Who published it, when the caller is identified. */
  publishedBy?: string;
  /** Set when this entry restored an earlier version rather than a new one. */
  restoredFrom?: string;
  policies: Policy[];
}

export interface PolicyHistory {
  record(
    policies: readonly Policy[],
    publishedAt: string,
    publishedBy?: string,
    restoredFrom?: string,
  ): Promise<PolicyVersionRecord>;
  list(): Promise<PolicyVersionRecord[]>;
  findByVersion(version: string): Promise<PolicyVersionRecord | null>;
}

/** Newest first: a rollback almost always targets something recent. */
export class FilePolicyHistory implements PolicyHistory {
  constructor(private readonly dataDir: string) {}

  async record(
    policies: readonly Policy[],
    publishedAt: string,
    publishedBy?: string,
    restoredFrom?: string,
  ): Promise<PolicyVersionRecord> {
    const stamped = versionPolicySet(policies);
    const entry: PolicyVersionRecord = {
      version: stamped.version,
      policyCount: stamped.policyCount,
      policyNames: stamped.policyNames,
      publishedAt,
      ...(publishedBy === undefined ? {} : { publishedBy }),
      ...(restoredFrom === undefined ? {} : { restoredFrom }),
      policies: [...policies],
    };
    const existing = await this.list();
    await this.write([entry, ...existing].slice(0, MAX_HISTORY_ENTRIES));
    return entry;
  }

  async list(): Promise<PolicyVersionRecord[]> {
    try {
      return JSON.parse(await readFile(this.path(), 'utf8')) as PolicyVersionRecord[];
    } catch {
      return []; // Nothing published yet.
    }
  }

  async findByVersion(version: string): Promise<PolicyVersionRecord | null> {
    const found = (await this.list()).find((entry) => entry.version === version);
    return found ?? null;
  }

  private path(): string {
    return join(this.dataDir, HISTORY_FILE);
  }

  private async write(entries: PolicyVersionRecord[]): Promise<void> {
    await mkdir(dirname(this.path()), { recursive: true });
    await writeFile(this.path(), JSON.stringify(entries, null, 2), 'utf8');
  }
}
