import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DestinationRecords,
  isNewDestination,
  MOST_DESTINATIONS,
  noteDestination,
  PROBATION_DAYS,
  PROBATION_KIND,
  ProbationRegister,
  probationOf,
  probationsInForce,
  SessionContainments,
  trustCommandFor,
} from '../src/index';

const START = new Date('2026-09-24T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

async function register(): Promise<ProbationRegister> {
  return new ProbationRegister(await mkdtemp(join(tmpdir(), 'memnox-probation-')));
}

describe('probation for something new', () => {
  it('starts for the named number of days', async () => {
    const probation = await register();
    const entry = await probation.start(
      { kind: PROBATION_KIND.AGENT, name: 'codex-cli', label: 'Codex' },
      START,
    );
    expect(entry?.until).toBe(
      new Date(START.getTime() + PROBATION_DAYS * DAY).toISOString(),
    );
    const all = await probation.all();
    expect(probationOf(all, PROBATION_KIND.AGENT, 'codex-cli', START)?.label).toBe(
      'Codex',
    );
  });

  it('is found by the name a screen prints as well as the one a seam speaks as', async () => {
    const probation = await register();
    await probation.start(
      { kind: PROBATION_KIND.AGENT, name: 'claude-code', label: 'Claude Code' },
      START,
    );
    const all = await probation.all();
    expect(probationOf(all, PROBATION_KIND.AGENT, 'Claude Code', START)).not.toBeNull();
    expect(probationOf(all, PROBATION_KIND.MCP_SERVER, 'claude-code', START)).toBeNull();
  });

  it('ends on its own when the period is over', async () => {
    const probation = await register();
    await probation.start({ kind: PROBATION_KIND.MCP_SERVER, name: 'slack' }, START);
    const later = new Date(START.getTime() + (PROBATION_DAYS + 1) * DAY);
    const all = await probation.all();
    expect(probationOf(all, PROBATION_KIND.MCP_SERVER, 'slack', later)).toBeNull();
    expect(probationsInForce(all, later)).toEqual([]);
  });

  it('ends at once when a person trusts it, on the record', async () => {
    const probation = await register();
    await probation.start({ kind: PROBATION_KIND.MCP_SERVER, name: 'slack' }, START);
    const trusted = await probation.trust(PROBATION_KIND.MCP_SERVER, 'slack', START);
    expect(trusted?.trustedAt).toBe(START.toISOString());
    expect(
      probationOf(await probation.all(), PROBATION_KIND.MCP_SERVER, 'slack', START),
    ).toBeNull();
  });

  it('is never started again by a rewritten config, once served or trusted', async () => {
    const probation = await register();
    await probation.start({ kind: PROBATION_KIND.AGENT, name: 'cursor' }, START);
    await probation.trust(PROBATION_KIND.AGENT, 'cursor', START);
    expect(
      await probation.start({ kind: PROBATION_KIND.AGENT, name: 'cursor' }, START),
    ).toBeNull();
  });

  it('answers a trust for something never on probation with nothing', async () => {
    expect(
      await (await register()).trust(PROBATION_KIND.AGENT, 'nobody', START),
    ).toBeNull();
  });

  it('names the command that ends it, per kind', () => {
    expect(trustCommandFor(PROBATION_KIND.AGENT, 'cursor')).toBe(
      'memnox agents trust cursor',
    );
    expect(trustCommandFor(PROBATION_KIND.MCP_SERVER, 'slack')).toBe(
      'memnox mcp trust slack',
    );
  });
});

describe('the destinations each agent has reached', () => {
  it('says whether a host is new, and remembers it once reached', async () => {
    const records = new DestinationRecords(await mkdtemp(join(tmpdir(), 'memnox-dest-')));
    expect(
      (await records.record('claude-code', 'API.example.com', START.toISOString())).first,
    ).toBe(true);
    expect(
      (await records.record('claude-code', 'api.example.com', START.toISOString())).first,
    ).toBe(false);
    const seen = await records.read('claude-code');
    expect(isNewDestination(seen, 'api.example.com')).toBe(false);
    expect(isNewDestination(seen, 'other.example.com')).toBe(true);
    expect(seen.hosts[0]?.count).toBe(2);
    // Per agent: what one agent reached says nothing about another.
    expect(isNewDestination(await records.read('cursor'), 'api.example.com')).toBe(true);
  });

  it('stays bounded, dropping the least recently seen', () => {
    let record = {
      agent: 'a',
      hosts: [] as ReturnType<typeof noteDestination>['record']['hosts'],
    };
    for (let index = 0; index <= MOST_DESTINATIONS; index += 1) {
      record = noteDestination(
        record,
        `h${index}.example`,
        new Date(START.getTime() + index).toISOString(),
      ).record;
    }
    expect(record.hosts).toHaveLength(MOST_DESTINATIONS);
    expect(isNewDestination(record, 'h0.example')).toBe(true);
  });
});

describe('what a run drew around its session', () => {
  it('is written for the seams and read back by session', async () => {
    const containments = new SessionContainments(
      await mkdtemp(join(tmpdir(), 'memnox-cont-')),
    );
    await containments.declare({
      sessionId: 'ses_1',
      agent: 'claude-code',
      root: '/work/shop',
      untrusted: true,
      startedAt: START.toISOString(),
    });
    expect((await containments.read('ses_1'))?.untrusted).toBe(true);
    await containments.clear('ses_1');
    expect(await containments.read('ses_1')).toBeNull();
  });
});
