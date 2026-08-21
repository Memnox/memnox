import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TextCodec } from '@memnox/core';
import { PLAIN_TEXT_CODEC } from '@memnox/core';
import type { Stated, StatedStore } from '@memnox/org-graph';
import { SECRET_DIR_MODE, SECRET_FILE_MODE } from './file-mode';

/** One JSON file, reviewable and diffable on purpose. */
export class JsonFileStatedStore implements StatedStore {
  private statements = new Map<string, Stated>();
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly codec: TextCodec = PLAIN_TEXT_CODEC,
  ) {}

  save(stated: Stated): Promise<void> {
    return this.saveAll([stated]);
  }

  /** One write for the whole batch, so a pair of changes cannot half-land. */
  async saveAll(statements: readonly Stated[]): Promise<void> {
    await this.ensureLoaded();
    for (const stated of statements) this.statements.set(stated.id, stated);
    await this.persist();
  }

  async findById(id: string): Promise<Stated | null> {
    await this.ensureLoaded();
    return this.statements.get(id) ?? null;
  }

  async list(workspaceId: string): Promise<Stated[]> {
    await this.ensureLoaded();
    return [...this.statements.values()].filter(
      (stated) => stated.workspaceId === workspaceId,
    );
  }

  async remove(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const removed = this.statements.delete(id);
    if (removed) await this.persist();
    return removed;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = this.codec.decode(await readFile(this.filePath, 'utf8'));
      const parsed = JSON.parse(raw) as Stated[];
      this.statements = new Map(parsed.map((stated) => [stated.id, stated]));
    } catch {
      // First run — file does not exist yet.
      this.statements = new Map();
    }
  }

  /** A truncated write here is not a lost update, it is a company misdescribed. */
  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: SECRET_DIR_MODE });
    const serialized = JSON.stringify([...this.statements.values()], null, 2);
    const scratch = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(scratch, this.codec.encode(serialized), {
      encoding: 'utf8',
      mode: SECRET_FILE_MODE,
    });
    await rename(scratch, this.filePath);
  }
}

export class InMemoryStatedStore implements StatedStore {
  private readonly statements = new Map<string, Stated>();

  save(stated: Stated): Promise<void> {
    return this.saveAll([stated]);
  }

  async saveAll(statements: readonly Stated[]): Promise<void> {
    for (const stated of statements) this.statements.set(stated.id, stated);
  }

  async findById(id: string): Promise<Stated | null> {
    return this.statements.get(id) ?? null;
  }

  async list(workspaceId: string): Promise<Stated[]> {
    return [...this.statements.values()].filter(
      (stated) => stated.workspaceId === workspaceId,
    );
  }

  async remove(id: string): Promise<boolean> {
    return this.statements.delete(id);
  }
}
