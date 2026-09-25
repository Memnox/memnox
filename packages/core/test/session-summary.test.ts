import { describe, expect, it } from 'vitest';
import { summarizeSession, systemOf } from '../src/session/session-summary';
import type { MemnoxEvent } from '../src/event/event';

let at = 0;
function row(fields: Partial<MemnoxEvent>): MemnoxEvent {
  at += 1;
  return {
    id: `evt_${at}`,
    schemaVersion: 1,
    at: `2026-09-25T10:00:${String(at).padStart(2, '0')}.000Z`,
    sessionId: 'ses_1',
    agent: 'claude-code',
    actorType: 'agent',
    surface: 'shell',
    operation: 'shell.execute',
    class: 'read',
    effect: 'allow',
    mode: 'enforce',
    reason: 'no rule matched',
    ...fields,
  } as MemnoxEvent;
}

describe('one session, added up', () => {
  it('counts distinct files, and systems by reads and changes', () => {
    const summary = summarizeSession([
      row({ operation: 'file.read', target: '/r/a.ts' }),
      row({ operation: 'file.read', target: '/r/a.ts' }),
      row({ operation: 'file.read', target: '/r/b.ts' }),
      row({ operation: 'file.edit', target: '/r/a.ts', class: 'write' }),
      row({ operation: 'gh.pr-view', target: '12' }),
      row({ operation: 'gh.pr-view', target: '13' }),
      row({ operation: 'gh.pr-create', class: 'write' }),
      row({ operation: 'railway.logs' }),
      row({ operation: 'mcp.stripe.retrieve_payment_intent' }),
      row({ operation: 'http.request', target: 'api.example.com' }),
    ]);
    expect(summary?.filesRead).toBe(2);
    expect(summary?.filesChanged).toBe(1);
    expect(summary?.systems).toEqual([
      { name: 'gh', reads: 2, changes: 1 },
      { name: 'api.example.com', reads: 1, changes: 0 },
      { name: 'railway', reads: 1, changes: 0 },
      { name: 'stripe (MCP)', reads: 1, changes: 0 },
    ]);
  });

  it('names what was stopped, and counts nothing that never ran as done', () => {
    const summary = summarizeSession([
      row({
        operation: 'railway.redeploy',
        class: 'write',
        effect: 'deny',
        reason: 'read only',
      }),
      row({
        operation: 'gh.pr-merge',
        class: 'write',
        execution: 'blocked',
        effect: 'ask',
      }),
      row({ operation: 'gh.pr-view' }),
    ]);
    expect(summary?.blockedCount).toBe(2);
    expect(summary?.blocked[0]).toEqual({
      operation: 'railway.redeploy',
      reason: 'read only',
    });
    expect(summary?.systems).toEqual([{ name: 'gh', reads: 1, changes: 0 }]);
  });

  it('is nothing for a session with no rows', () => {
    expect(summarizeSession([])).toBeNull();
  });

  it('leaves local work out of the systems', () => {
    expect(systemOf({ operation: 'shell.execute' })).toBeNull();
    expect(systemOf({ operation: 'filesystem.write', target: '/x' })).toBeNull();
    expect(systemOf({ operation: 'mcp.list_issues', target: 'github' })).toBe(
      'github (MCP)',
    );
  });
});
