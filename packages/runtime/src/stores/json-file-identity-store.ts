import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgentIdentity, IdentityStore, TextCodec } from '@memnox/core';
import { PLAIN_TEXT_CODEC } from '@memnox/core';

/** Local agent registry persisted as a single JSON file — inspectable and diffable. */
export class JsonFileIdentityStore implements IdentityStore {
  private agents = new Map<string, AgentIdentity>();
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly codec: TextCodec = PLAIN_TEXT_CODEC,
  ) {}

  async save(agent: AgentIdentity): Promise<void> {
    await this.ensureLoaded();
    this.agents.set(agent.id, agent);
    await this.persist();
  }

  async findById(id: string): Promise<AgentIdentity | null> {
    await this.ensureLoaded();
    return this.agents.get(id) ?? null;
  }

  async findByTokenHash(tokenHash: string): Promise<AgentIdentity | null> {
    await this.ensureLoaded();
    for (const agent of this.agents.values()) {
      if (agent.tokenHash === tokenHash) return agent;
    }
    return null;
  }

  async list(): Promise<AgentIdentity[]> {
    await this.ensureLoaded();
    return [...this.agents.values()];
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = this.codec.decode(await readFile(this.filePath, 'utf8'));
      const parsed = JSON.parse(raw) as AgentIdentity[];
      this.agents = new Map(parsed.map((agent) => [agent.id, agent]));
    } catch {
      // First run — file does not exist yet.
      this.agents = new Map();
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const serialized = JSON.stringify([...this.agents.values()], null, 2);
    await writeFile(this.filePath, this.codec.encode(serialized), 'utf8');
  }
}
