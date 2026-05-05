import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TextCodec } from '@memnox/core';
import { PLAIN_TEXT_CODEC } from '@memnox/core';
import type { DecisionRecord, DecisionStore } from './decision-record';

/** Local decision memory persisted as one JSON file — reviewable and diffable. */
export class JsonFileDecisionStore implements DecisionStore {
  private records = new Map<string, DecisionRecord>();
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly codec: TextCodec = PLAIN_TEXT_CODEC,
  ) {}

  async save(record: DecisionRecord): Promise<void> {
    await this.ensureLoaded();
    this.records.set(record.id, record);
    await this.persist();
  }

  async list(): Promise<DecisionRecord[]> {
    await this.ensureLoaded();
    return [...this.records.values()];
  }

  async remove(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const removed = this.records.delete(id);
    if (removed) await this.persist();
    return removed;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = this.codec.decode(await readFile(this.filePath, 'utf8'));
      const parsed = JSON.parse(raw) as DecisionRecord[];
      this.records = new Map(parsed.map((record) => [record.id, record]));
    } catch {
      // First run — file does not exist yet.
      this.records = new Map();
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      this.codec.encode(JSON.stringify([...this.records.values()], null, 2)),
      'utf8',
    );
  }
}

export class InMemoryDecisionStore implements DecisionStore {
  private readonly records = new Map<string, DecisionRecord>();

  async save(record: DecisionRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async list(): Promise<DecisionRecord[]> {
    return [...this.records.values()];
  }

  async remove(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
}
