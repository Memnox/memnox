import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PLAIN_TEXT_CODEC, type TextCodec } from '@memnox/core';
import type { Policy } from '@memnox/policy-engine';
import { versionPolicySet } from '@memnox/policy-engine';
import { isFileMissing } from './file-errors';

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
  // Rule bodies name protected paths and targets, so this file is as sensitive
  // as the stores beside it and gets the same codec.
  constructor(
    private readonly dataDir: string,
    private readonly codec: TextCodec = PLAIN_TEXT_CODEC,
  ) {}

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
    let stored: string;
    try {
      stored = await readFile(this.path(), 'utf8');
    } catch (error) {
      // Nothing published yet is the only acceptable read failure; a decode
      // error must not read as "no history" and quietly drop every version.
      if (isFileMissing(error)) return [];
      throw error;
    }
    return JSON.parse(this.codec.decode(stored)) as PolicyVersionRecord[];
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
    await writeFile(
      this.path(),
      this.codec.encode(JSON.stringify(entries, null, 2)),
      'utf8',
    );
  }
}
