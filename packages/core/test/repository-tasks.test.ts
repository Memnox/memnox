import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RepositoryTasks, scopeOf } from '../src/session/session-task';
import { matchesAny } from '../src/policy/pattern-matcher';

describe('a task declared for a repository', () => {
  it('stands for its hours, and then is gone', async () => {
    const tasks = new RepositoryTasks(await mkdtemp(join(tmpdir(), 'memnox-task-')));
    await tasks.declare(
      '/w/app',
      { statement: 'fix the retry', scope: { paths: ['/w/app/src/payments/**'] } },
      { now: '2026-09-25T10:00:00.000Z', hours: 2 },
    );
    expect((await tasks.inForce('/w/app', '2026-09-25T11:00:00.000Z'))?.statement).toBe(
      'fix the retry',
    );
    expect(await tasks.inForce('/w/app', '2026-09-25T12:30:00.000Z')).toBeNull();
    expect(await tasks.inForce('/w/other', '2026-09-25T11:00:00.000Z')).toBeNull();
  });

  it('is what a session compares against, as a session task would be', async () => {
    const tasks = new RepositoryTasks(await mkdtemp(join(tmpdir(), 'memnox-task-')));
    const task = await tasks.declare(
      '/w/app',
      { statement: 'fix the retry', scope: { paths: ['/w/app/src/payments/**'] } },
      { now: '2026-09-25T10:00:00.000Z' },
    );
    const match = (patterns: readonly string[], value: string): boolean =>
      matchesAny([...patterns], value);
    expect(
      scopeOf(
        task,
        { action: 'filesystem.write', target: '/w/app/src/infra/main.tf' },
        match,
      ).match,
    ).toBe('out_of_scope');
  });
});
