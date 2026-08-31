import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TextCodec } from '@memnox/core';
import { PLAIN_TEXT_CODEC } from '@memnox/core';
import type { StateFact } from '@memnox/org-graph';
import { SECRET_DIR_MODE, SECRET_FILE_MODE } from './file-mode';

export interface StateFactStore {
  save(fact: StateFact): Promise<void>;
  list(): Promise<StateFact[]>;
  remove(id: string): Promise<boolean>;
}

/** The company's current condition, small enough to ride inside the compiled bundle. */
export class JsonFileStateStore implements StateFactStore {
  private facts = new Map<string, StateFact>();
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly codec: TextCodec = PLAIN_TEXT_CODEC,
  ) {}

  async save(fact: StateFact): Promise<void> {
    await this.ensureLoaded();
    this.facts.set(fact.id, fact);
    await this.persist();
  }

  async list(): Promise<StateFact[]> {
    await this.ensureLoaded();
    return [...this.facts.values()];
  }

  async remove(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const removed = this.facts.delete(id);
    if (removed) await this.persist();
    return removed;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = this.codec.decode(await readFile(this.filePath, 'utf8'));
      const parsed = JSON.parse(raw) as StateFact[];
      this.facts = new Map(parsed.map((fact) => [fact.id, fact]));
    } catch {
      // First run — nothing has been declared about this company's condition yet.
      this.facts = new Map();
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: SECRET_DIR_MODE });
    await writeFile(
      this.filePath,
      this.codec.encode(JSON.stringify([...this.facts.values()], null, 2)),
      { encoding: 'utf8', mode: SECRET_FILE_MODE },
    );
  }
}

export class InMemoryStateStore implements StateFactStore {
  private readonly facts = new Map<string, StateFact>();

  async save(fact: StateFact): Promise<void> {
    this.facts.set(fact.id, fact);
  }

  async list(): Promise<StateFact[]> {
    return [...this.facts.values()];
  }

  async remove(id: string): Promise<boolean> {
    return this.facts.delete(id);
  }
}
