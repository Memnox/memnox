import { describe, expect, it } from 'vitest';
import {
  ENFORCEMENT_MODE,
  SEAM_KIND,
  SEAM_UNHEALTHY,
  seamCoverage,
  type Seam,
  type SeamStore,
} from '@memnox/core';
import { CONSOLE_LOGGER } from '../src/console-logger';
import { SeamService, isSeamKind, seamIdFor } from '../src/seam-service';

class MemorySeamStore implements SeamStore {
  readonly seams = new Map<string, Seam>();
  async save(seam: Seam): Promise<void> {
    this.seams.set(seam.id, seam);
  }
  async listByAgent(agentId: string): Promise<Seam[]> {
    return [...this.seams.values()].filter((seam) => seam.agentId === agentId);
  }
  async list(): Promise<Seam[]> {
    return [...this.seams.values()];
  }
  async remove(id: string): Promise<boolean> {
    return this.seams.delete(id);
  }
}

/** Throws on read, which a seam declaring itself must survive. */
class UnreadableSeamStore extends MemorySeamStore {
  override async listByAgent(): Promise<Seam[]> {
    throw new Error('disk gone');
  }
}

function service(
  store: SeamStore = new MemorySeamStore(),
  at = '2026-01-01T00:00:00.000Z',
): SeamService {
  return new SeamService({ store, logger: CONSOLE_LOGGER, now: () => at });
}

const proxy = {
  agentId: 'agt_1',
  kind: SEAM_KIND.MCP_PROXY,
  mode: ENFORCEMENT_MODE.ENFORCE,
  covers: ['mcp.*'],
  blindTo: ["the model's reasoning"],
};

describe('SeamService', () => {
  it('records what a seam sees and what it cannot', async () => {
    const seam = await service().register(proxy);

    expect(seam.id).toBe(seamIdFor('agt_1', SEAM_KIND.MCP_PROXY));
    expect(seam.covers).toEqual(['mcp.*']);
    expect(seam.blindTo).toEqual(["the model's reasoning"]);
    expect(seam.lastSeenAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('updates its row on restart rather than counting the seam twice', async () => {
    const store = new MemorySeamStore();
    await service(store, '2026-01-01T00:00:00.000Z').register(proxy);
    await service(store, '2026-01-02T00:00:00.000Z').register(proxy);

    const seams = await store.list();
    expect(seams).toHaveLength(1);
    expect(seams[0]?.lastSeenAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('keeps one row per kind, so two seams on one agent both count', async () => {
    const store = new MemorySeamStore();
    const seams = service(store);
    await seams.register(proxy);
    await seams.register({ ...proxy, kind: SEAM_KIND.HOOK, covers: ['filesystem.read'] });

    expect(await store.list()).toHaveLength(2);
    expect(seamCoverage(await store.list()).enforcing).toBe(2);
  });

  it('carries forward what a re-registration did not restate', async () => {
    const store = new MemorySeamStore();
    await service(store).register({
      ...proxy,
      installedBy: 'hs_1',
      whenUnhealthy: SEAM_UNHEALTHY.PROCEED,
    });
    const again = await service(store).register({
      agentId: 'agt_1',
      kind: SEAM_KIND.MCP_PROXY,
    });

    expect(again.installedBy).toBe('hs_1');
    expect(again.whenUnhealthy).toBe(SEAM_UNHEALTHY.PROCEED);
    expect(again.covers).toEqual(['mcp.*']);
  });

  it('observes by default — a first registration must not start enforcing', async () => {
    const seam = await service().register({ agentId: 'agt_1', kind: SEAM_KIND.HOOK });
    expect(seam.mode).toBe(ENFORCEMENT_MODE.OBSERVE);
  });

  it('withholds by default when the runtime is unhealthy', async () => {
    const seam = await service().register({ agentId: 'agt_1', kind: SEAM_KIND.HOOK });
    expect(seam.whenUnhealthy).toBe(SEAM_UNHEALTHY.WITHHOLD);
  });

  it('still registers when the store cannot be read, rather than refusing to declare', async () => {
    const seam = await service(new UnreadableSeamStore()).register(proxy);
    expect(seam.kind).toBe(SEAM_KIND.MCP_PROXY);
  });

  it('removing a seam removes its claim to coverage', async () => {
    const store = new MemorySeamStore();
    const seams = service(store);
    const seam = await seams.register(proxy);

    expect(await seams.remove(seam.id)).toBe(true);
    expect(await seams.remove(seam.id)).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it('knows a seam kind from a string somebody made up', () => {
    expect(isSeamKind(SEAM_KIND.HOOK)).toBe(true);
    expect(isSeamKind('everything')).toBe(false);
    expect(isSeamKind(undefined)).toBe(false);
  });
});
