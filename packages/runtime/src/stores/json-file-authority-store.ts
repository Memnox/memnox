import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TextCodec } from '@memnox/core';
import { PLAIN_TEXT_CODEC } from '@memnox/core';
import type { AuthorityGrant, AuthorityStore } from '@memnox/org-graph';
import { SECRET_DIR_MODE, SECRET_FILE_MODE } from './file-mode';

/** Delegated authority as a single JSON file — who may act for whom, up to what. */
export class JsonFileAuthorityStore implements AuthorityStore {
  private grants = new Map<string, AuthorityGrant>();
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly codec: TextCodec = PLAIN_TEXT_CODEC,
  ) {}

  async save(grant: AuthorityGrant): Promise<void> {
    await this.ensureLoaded();
    this.grants.set(grant.id, grant);
    await this.persist();
  }

  async list(workspaceId: string): Promise<AuthorityGrant[]> {
    await this.ensureLoaded();
    return [...this.grants.values()].filter((grant) => grant.workspaceId === workspaceId);
  }

  async remove(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const removed = this.grants.delete(id);
    if (removed) await this.persist();
    return removed;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = this.codec.decode(await readFile(this.filePath, 'utf8'));
      const parsed = JSON.parse(raw) as AuthorityGrant[];
      this.grants = new Map(parsed.map((grant) => [grant.id, grant]));
    } catch {
      // First run — file does not exist yet.
      this.grants = new Map();
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: SECRET_DIR_MODE });
    const serialized = JSON.stringify([...this.grants.values()], null, 2);
    await writeFile(this.filePath, this.codec.encode(serialized), {
      encoding: 'utf8',
      mode: SECRET_FILE_MODE,
    });
  }
}

export class InMemoryAuthorityStore implements AuthorityStore {
  private readonly grants = new Map<string, AuthorityGrant>();

  async save(grant: AuthorityGrant): Promise<void> {
    this.grants.set(grant.id, grant);
  }

  async list(workspaceId: string): Promise<AuthorityGrant[]> {
    return [...this.grants.values()].filter((grant) => grant.workspaceId === workspaceId);
  }

  async remove(id: string): Promise<boolean> {
    return this.grants.delete(id);
  }
}
