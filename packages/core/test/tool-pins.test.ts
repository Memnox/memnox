import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  changeBetween,
  changingTools,
  FileToolPins,
  toolArrivalEvent,
} from '../src/discovery/tool-pins';

describe('what a server listed against last time', () => {
  it('says nothing the first time, and pins what it saw', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-pins-'));
    const pins = new FileToolPins(home);
    const first = await pins.compare('railway', [{ name: 'list_deployments' }]);
    expect(first.first).toBe(true);

    const second = await pins.compare('railway', [
      { name: 'list_deployments' },
      { name: 'redeploy_service' },
    ]);
    expect(second.first).toBe(false);
    expect(changingTools(second).map((tool) => tool.name)).toEqual(['redeploy_service']);
  });

  it('counts a tool that kept its name and started to write', () => {
    const change = changeBetween(
      [{ name: 'sync', class: 'read' }],
      [{ name: 'sync', class: 'write' }],
    );
    expect(change.added).toEqual([{ name: 'sync', class: 'write' }]);
  });

  it('names what went', () => {
    const change = changeBetween([{ name: 'get_logs', class: 'read' }], []);
    expect(change.removed).toEqual(['get_logs']);
  });

  it('keeps the row to names and whether a rule covers them', () => {
    const row = toolArrivalEvent({
      server: 'railway',
      tools: [{ name: 'redeploy_service', class: 'write' }],
      unruled: ['redeploy_service'],
      sessionId: 'ses_1',
      agent: 'claude-code',
      at: '2026-09-25T10:00:00.000Z',
      mode: 'enforce',
    });
    expect(row.surface).toBe('config');
    expect(row.reason).toContain('no rule covers redeploy_service');
  });
});
