import { describe, expect, it } from 'vitest';
import {
  applyNative,
  NATIVE_MARKER,
  revertNative,
  toClaudeCodePermissions,
} from '../src/policy/native';
import type { Policy } from '../src/policy/policy';

const rule = (
  name: string,
  actions: string[],
  effect: string,
  targets?: string[],
): Policy =>
  ({
    name,
    match: { actions, ...(targets === undefined ? {} : { targets }) },
    decision: { effect, reason: 'because' },
  }) as unknown as Policy;

describe('writing rules into Claude Code’s own permissions', () => {
  it('puts each effect in its own list', () => {
    const { permissions } = toClaudeCodePermissions([
      rule('a', ['filesystem.read'], 'allow'),
      rule('b', ['shell.execute'], 'ask'),
      rule('c', ['filesystem.write'], 'deny'),
    ]);

    expect(permissions.allow).toContain('Read');
    expect(permissions.ask).toContain('Bash');
    expect(permissions.deny).toContain('Write');
  });

  it('turns a git action into the Bash pattern that actually matches it', () => {
    const { permissions } = toClaudeCodePermissions([rule('a', ['git.push'], 'deny')]);
    expect(permissions.deny).toContain('Bash(git push:*)');
  });

  it('carries the target into the permission, so a rule keeps its scope', () => {
    const { permissions } = toClaudeCodePermissions([
      rule('a', ['filesystem.read'], 'deny', ['~/.aws/**']),
    ]);
    expect(permissions.deny).toContain('Read(~/.aws/**)');
  });

  it('names what it could not translate, rather than dropping it silently', () => {
    const { untranslated } = toClaudeCodePermissions([
      rule('a', ['database.delete'], 'deny'),
      rule('b', [], 'deny'),
    ]);
    expect(untranslated.map((each) => each.policy)).toEqual(['a', 'b']);
    expect(untranslated[0]?.because).toContain('no Claude Code permission covers');
  });

  it('never writes the same permission twice', () => {
    const { permissions } = toClaudeCodePermissions([
      rule('a', ['filesystem.read'], 'deny'),
      rule('b', ['filesystem.read'], 'deny'),
    ]);
    expect(permissions.deny.filter((each) => each === 'Read')).toHaveLength(1);
  });
});

describe('applying and reverting', () => {
  const translation = toClaudeCodePermissions([rule('a', ['filesystem.write'], 'deny')]);
  const theirs = {
    permissions: { allow: ['Read'], deny: ['Bash(rm:*)'] },
    otherSetting: true,
  };

  it('adds ours beside theirs and keeps the rest of the file', () => {
    const after = applyNative(theirs, translation);
    expect(after.permissions?.deny).toEqual(['Bash(rm:*)', 'Write']);
    expect(after.permissions?.allow).toEqual(['Read']);
    expect(after['otherSetting']).toBe(true);
  });

  it('records what it wrote, so a revert never has to guess', () => {
    const after = applyNative(theirs, translation);
    expect(after[NATIVE_MARKER]).toEqual({ allow: [], ask: [], deny: ['Write'] });
  });

  it('takes back only ours, leaving every rule they wrote', () => {
    const restored = revertNative(applyNative(theirs, translation));
    expect(restored.permissions?.deny).toEqual(['Bash(rm:*)']);
    expect(restored.permissions?.allow).toEqual(['Read']);
    expect(restored[NATIVE_MARKER]).toBeUndefined();
  });

  it('is a no-op on a file we never touched', () => {
    expect(revertNative(theirs)).toBe(theirs);
  });
});
