import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Seam, SeamStore } from '@memnox/core';
import { SECRET_DIR_MODE, SECRET_FILE_MODE } from './file-mode';

/** Which seams are installed, in what mode, and what each one cannot see. */
export class JsonFileSeamStore implements SeamStore {
  private seams = new Map<string, Seam>();
  private loaded = false;

  constructor(private readonly filePath: string) {}

  async save(seam: Seam): Promise<void> {
    await this.ensureLoaded();
    this.seams.set(seam.id, seam);
    await this.persist();
  }

  async listByAgent(agentId: string): Promise<Seam[]> {
    await this.ensureLoaded();
    return [...this.seams.values()].filter((seam) => seam.agentId === agentId);
  }

  async list(): Promise<Seam[]> {
    await this.ensureLoaded();
    return [...this.seams.values()];
  }

  async remove(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const removed = this.seams.delete(id);
    if (removed) await this.persist();
    return removed;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Seam[];
      this.seams = new Map(parsed.map((seam) => [seam.id, seam]));
    } catch {
      // First run — no seam has been installed on this machine yet.
      this.seams = new Map();
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: SECRET_DIR_MODE });
    await writeFile(this.filePath, JSON.stringify([...this.seams.values()], null, 2), {
      encoding: 'utf8',
      mode: SECRET_FILE_MODE,
    });
  }
}
