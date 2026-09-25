import { describe, expect, it } from 'vitest';
import { CHANGE_DIRECTION, CHANGE_SUBJECT, type EnvironmentChange } from '@memnox/core';
import { DRIFT_GROUP, driftItems, driftNotices } from '../src/keeper/keep-drift';

function drift(changes: EnvironmentChange[]): Parameters<typeof driftItems>[0] {
  return { changes, logins: [], updates: [], arrived: [] } as never;
}

describe('what the daemon says when a server comes or goes', () => {
  it('names a server that is gone, because an agent relying on it will fail', () => {
    const items = driftItems(
      drift([
        {
          subject: CHANGE_SUBJECT.SERVER,
          name: 'railway',
          direction: CHANGE_DIRECTION.NARROWS,
          detail: 'removed',
          grantedBy: '~/.claude.json',
        } as EnvironmentChange,
      ]),
    );
    expect(items.map((item) => item.group)).toEqual([DRIFT_GROUP.SERVER_GONE]);
    expect(driftNotices(items)[0]).toContain('MCP server gone: railway');
  });

  it('says what a new server brings, reads included', () => {
    const items = driftItems(
      drift([
        {
          subject: CHANGE_SUBJECT.SERVER,
          name: 'sentry',
          direction: CHANGE_DIRECTION.WIDENS,
          detail: '14 tools · 11 read · 3 write',
        } as EnvironmentChange,
      ]),
    );
    expect(driftNotices(items)[0]).toContain(
      'New MCP server: sentry (14 tools · 11 read · 3 write)',
    );
  });
});
