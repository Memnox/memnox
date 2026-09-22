import { describe, expect, it } from 'vitest';
import {
  editHookCommand,
  withEditHook,
  withoutEditHook,
} from '../src/protect/claude-hook';

const OURS = 'memnox-edit-hook';

/* The file is somebody's editor configuration: a hook they wrote themselves has to
   survive both directions, and installing twice must not run the hook twice. */
describe("Claude Code's settings with the lease hook", () => {
  const theirs = {
    model: 'opus',
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint-it' }] }],
    },
  };

  it('adds the hook beside what is already there, and keeps the rest', () => {
    const next = withEditHook(theirs, OURS);

    expect(next['model']).toBe('opus');
    expect(next.hooks?.['PreToolUse']).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'lint-it' }] },
      {
        matcher: 'Write|Edit|MultiEdit|NotebookEdit',
        hooks: [{ type: 'command', command: OURS }],
      },
    ]);
    expect(next.hooks?.['SessionEnd']).toEqual([
      { hooks: [{ type: 'command', command: OURS }] },
    ]);
  });

  it('installs once however many times it is asked', () => {
    const twice = withEditHook(withEditHook(theirs, OURS), OURS);

    expect(twice).toEqual(withEditHook(theirs, OURS));
  });

  it('takes out only what it put in', () => {
    expect(withoutEditHook(withEditHook(theirs, OURS))).toEqual(theirs);
    expect(withoutEditHook(withEditHook({}, OURS))).toEqual({});
  });
});

/* The bare name on a machine where it is not on PATH fails on every write, and the
   editor says so where nobody reads it, so the lease is silently never taken. */
describe('what the hook entry runs', () => {
  it('names the binary where it is on PATH', () => {
    expect(
      editHookCommand(
        '/usr/local/bin',
        (file) => file === '/usr/local/bin/memnox-edit-hook',
        '/x/edit-hook.js',
      ),
    ).toBe(OURS);
  });

  it('runs the built one by its path where it is not, and is still found as ours', () => {
    const command = editHookCommand(
      '/usr/bin',
      (file) => file === '/x/edit-hook.js',
      '/x/edit-hook.js',
    );

    expect(command).toContain('"/x/edit-hook.js"');
    expect(withoutEditHook(withEditHook({}, command))).toEqual({});
  });
});
