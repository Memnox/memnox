import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DestinationRecords, type MemnoxEvent } from '@memnox/core';
import { FIRST_DESTINATION_OPERATION, recordEgress } from '../src/egress-server';

describe('the first time an agent reaches a host', () => {
  it('is a row of its own, and the second visit is not', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-egress-'));
    const rows: MemnoxEvent[] = [];
    const ledger = {
      append: async (event: MemnoxEvent): Promise<void> => {
        rows.push(event);
      },
    } as never;
    const record = recordEgress(
      ledger,
      new DestinationRecords(home),
      () => new Date('2026-09-25T10:00:00.000Z'),
    );
    const ruling = {
      caller: { agent: 'claude-code' },
      action: 'http.connect',
      target: 'api.stripe.com:443',
      effect: 'allow' as const,
      reason: 'no rule matched',
    };
    await record(ruling as never);
    await record(ruling as never);
    const firsts = rows.filter((row) => row.operation === FIRST_DESTINATION_OPERATION);
    expect(firsts).toHaveLength(1);
    expect(firsts[0]?.reason).toContain('first time claude-code reached');
  });
});
