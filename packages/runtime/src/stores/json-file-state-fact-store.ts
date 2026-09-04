import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { StateFact, StateFactStore } from '@memnox/core';
import { SECRET_DIR_MODE, SECRET_FILE_MODE } from './file-mode';

/** A freeze has to survive a restart, or the first thing an incident does is lapse. */
export class JsonFileStateFactStore implements StateFactStore {
  private facts = new Map<string, StateFact>();
  private loaded = false;

  constructor(private readonly filePath: string) {}

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
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as StateFact[];
      this.facts = new Map(parsed.map((fact) => [fact.id, fact]));
    } catch {
      // First run — nothing has ever been declared in force on this machine.
      this.facts = new Map();
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: SECRET_DIR_MODE });
    await writeFile(this.filePath, JSON.stringify([...this.facts.values()], null, 2), {
      encoding: 'utf8',
      mode: SECRET_FILE_MODE,
    });
  }
}
