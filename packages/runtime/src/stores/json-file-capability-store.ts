import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  Capability,
  CapabilityStore,
  Lease,
  LeaseStore,
  TextCodec,
} from '@memnox/core';
import { isLeaseLive, PLAIN_TEXT_CODEC } from '@memnox/core';
import { SECRET_DIR_MODE, SECRET_FILE_MODE } from './file-mode';

/**
 * A grant that vanished on restart is a permission nobody can audit, so what an agent
 * may ask for outlives the process that granted it.
 */
export class JsonFileCapabilityStore implements CapabilityStore {
  private readonly file: JsonRecordFile<Capability>;

  constructor(filePath: string, codec: TextCodec = PLAIN_TEXT_CODEC) {
    this.file = new JsonRecordFile<Capability>(filePath, codec);
  }

  async save(capability: Capability): Promise<void> {
    await this.file.set(capability.id, capability);
  }

  async findById(id: string): Promise<Capability | null> {
    return this.file.get(id);
  }

  async listByAgent(agentId: string): Promise<Capability[]> {
    return (await this.file.values()).filter((each) => each.agentId === agentId);
  }
}

/**
 * Leases persist for the same reason: a restart must not quietly hand back authority
 * a kill had revoked, and the ledger's record of who held what has to be checkable.
 */
export class JsonFileLeaseStore implements LeaseStore {
  private readonly file: JsonRecordFile<Lease>;

  constructor(filePath: string, codec: TextCodec = PLAIN_TEXT_CODEC) {
    this.file = new JsonRecordFile<Lease>(filePath, codec);
  }

  async save(lease: Lease): Promise<void> {
    await this.file.set(lease.id, lease);
  }

  async findById(id: string): Promise<Lease | null> {
    return this.file.get(id);
  }

  async listByAgent(agentId: string): Promise<Lease[]> {
    return (await this.file.values()).filter((each) => each.agentId === agentId);
  }

  async revokeAllFor(agentId: string, at: string): Promise<number> {
    const now = new Date(at);
    let revoked = 0;
    for (const lease of await this.file.values()) {
      if (lease.agentId !== agentId) continue;
      if (!isLeaseLive(lease, now)) continue;
      await this.file.set(lease.id, { ...lease, revokedAt: at });
      revoked += 1;
    }
    return revoked;
  }
}

/** One keyed JSON file, loaded once and written whole. Both stores are small by design. */
class JsonRecordFile<TRecord> {
  private records = new Map<string, TRecord>();
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly codec: TextCodec,
  ) {}

  async get(id: string): Promise<TRecord | null> {
    await this.ensureLoaded();
    return this.records.get(id) ?? null;
  }

  async values(): Promise<TRecord[]> {
    await this.ensureLoaded();
    return [...this.records.values()];
  }

  async set(id: string, record: TRecord): Promise<void> {
    await this.ensureLoaded();
    this.records.set(id, record);
    await this.persist();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = this.codec.decode(await readFile(this.filePath, 'utf8'));
      this.records = new Map(Object.entries(JSON.parse(raw) as Record<string, TRecord>));
    } catch {
      // First run — nothing has been granted or issued on this machine yet.
      this.records = new Map();
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: SECRET_DIR_MODE });
    await writeFile(
      this.filePath,
      this.codec.encode(JSON.stringify(Object.fromEntries(this.records), null, 2)),
      { encoding: 'utf8', mode: SECRET_FILE_MODE },
    );
  }
}
