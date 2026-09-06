import { describe, expect, it } from 'vitest';
import {
  applyNative,
  applyOpenClaw,
  NATIVE_MARKER,
  revertNative,
  revertOpenClaw,
  toClaudeCodePermissions,
  toHermesApprovals,
  toOpenClawTools,
} from '../src/policy/native';
import { commandGlobFor } from '../src/verbs/verb-table';
import { verbTableFor } from '../src/verbs/tables';
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

describe('the same rules in OpenClaw', () => {
  const policy = (
    name: string,
    effect: 'allow' | 'ask' | 'deny',
    actions: string[],
  ): Policy =>
    ({
      name,
      match: { actions },
      decision: { effect, reason: 'because' },
    }) as unknown as Policy;

  it('maps a Memnox action onto every tool OpenClaw gates it with', () => {
    const { tools } = toOpenClawTools([
      policy('no-shell', 'deny', ['shell.execute']),
      policy('reads-fine', 'allow', ['filesystem.read']),
    ]);

    expect(tools.deny.sort()).toEqual(['exec', 'process']);
    expect(tools.allow).toEqual(['read']);
  });

  /* OpenClaw has two effects and Memnox has three. Writing an ask as an allow drops
     the approval; writing it as a deny breaks work meant to continue after a prompt. */
  it('refuses to write an ask, and says why rather than guessing', () => {
    const { tools, untranslated } = toOpenClawTools([
      policy('ask-first', 'ask', ['shell.execute']),
    ]);

    expect(tools).toEqual({ allow: [], deny: [] });
    expect(untranslated[0]?.because).toContain('allow and deny only');
  });

  it('lets deny win, because that is how OpenClaw reads the two lists', () => {
    const { tools } = toOpenClawTools([
      policy('allow-writes', 'allow', ['filesystem.write']),
      policy('no-patching', 'deny', ['file.write']),
    ]);

    expect(tools.deny.sort()).toEqual(['apply_patch', 'edit', 'write']);
    // A tool in both lists would read as a contradiction to whoever opens the file.
    expect(tools.allow).toEqual([]);
  });

  it('names a rule no tool covers, rather than dropping it', () => {
    const { untranslated } = toOpenClawTools([
      policy('no-egress', 'deny', ['http.request']),
    ]);

    expect(untranslated[0]?.because).toContain('no OpenClaw tool covers');
  });

  it('merges beside what is there, and a revert takes back only ours', () => {
    const settings = { tools: { allow: ['read'], deny: ['canvas'], profile: 'custom' } };
    const translation = toOpenClawTools([policy('no-shell', 'deny', ['shell.execute'])]);

    const applied = applyOpenClaw(settings, translation);
    expect(applied.tools?.deny).toEqual(['canvas', 'exec', 'process']);
    // Anything else in the block is theirs and survives untouched.
    expect(applied.tools?.['profile']).toBe('custom');

    const reverted = revertOpenClaw(applied);
    expect(reverted.tools?.deny).toEqual(['canvas']);
    expect(reverted.tools?.allow).toEqual(['read']);
    expect(reverted[NATIVE_MARKER]).toBeUndefined();
  });
});

describe('the same rules in Hermes', () => {
  const policy = (name: string, effect: 'deny' | 'ask', actions: string[]): Policy =>
    ({
      name,
      match: { actions },
      decision: { effect, reason: 'because' },
    }) as unknown as Policy;

  const glob = (action: string): string | null => commandGlobFor(action, verbTableFor);

  /* The pattern comes from the verb table the evaluator reads, so what is written into
     somebody's config gates exactly what Memnox itself would have refused. */
  it('derives the command glob from the shipped verb table', () => {
    expect(glob('git.push-force')).toBe('git push --force*');
    expect(glob('git.reset-hard')).toBe('git reset --hard*');
    expect(glob('nonsense.verb')).toBeNull();
  });

  it('writes a deny as a lowercased glob, which is what Hermes compares', () => {
    const { deny } = toHermesApprovals(
      [policy('no-force', 'deny', ['git.push-force'])],
      glob,
    );

    expect(deny).toEqual(['git push --force*']);
  });

  it('refuses to write an ask, because approvals.deny cannot be answered', () => {
    const { deny, untranslated } = toHermesApprovals(
      [policy('ask-first', 'ask', ['git.push-force'])],
      glob,
    );

    expect(deny).toEqual([]);
    expect(untranslated[0]?.because).toContain('unconditional');
  });

  it('names a rule no command pattern covers rather than dropping it', () => {
    const { untranslated } = toHermesApprovals(
      [policy('no-secrets', 'deny', ['mcp.read_secret'])],
      glob,
    );

    expect(untranslated[0]?.because).toContain('no command pattern covers');
  });
});

describe('MCP tools in Claude Code permissions', () => {
  const policy = (
    name: string,
    effect: 'allow' | 'ask' | 'deny',
    actions: string[],
  ): Policy =>
    ({
      name,
      match: { actions },
      decision: { effect, reason: 'because' },
    }) as unknown as Policy;

  /* Verified against Claude Code's permission docs: a deny or ask may glob the
     tool-name position, and `mcp__*__<tool>` matches that tool on any server. */
  it('denies a tool across every server when the rule names no server', () => {
    const { permissions } = toClaudeCodePermissions([
      policy('no-deletion', 'deny', ['mcp.delete_customer']),
    ]);

    expect(permissions.deny).toEqual(['mcp__*__delete_customer']);
  });

  it('names the server when the rule named one', () => {
    const { permissions } = toClaudeCodePermissions([
      policy('no-stripe-refunds', 'deny', ['mcp.stripe.refund_payment']),
    ]);

    expect(permissions.deny).toEqual(['mcp__stripe__refund_payment']);
  });

  it('carries no parentheses, which Claude Code skips a rule for', () => {
    const withTarget = {
      name: 'no-deletion',
      match: { actions: ['mcp.delete_customer'], targets: ['crm'] },
      decision: { effect: 'deny', reason: 'because' },
    } as unknown as Policy;

    expect(toClaudeCodePermissions([withTarget]).permissions.deny).toEqual([
      'mcp__*__delete_customer',
    ]);
  });

  /* An unanchored allow glob is skipped by Claude Code with a warning, so writing one
     puts a line in somebody's settings that does nothing. Reported instead. */
  it('refuses to write an allow that does not name a server, and says why', () => {
    const { permissions, untranslated } = toClaudeCodePermissions([
      policy('let-reads', 'allow', ['mcp.read_customer']),
    ]);

    expect(permissions.allow).toEqual([]);
    expect(untranslated[0]?.because).toContain('has to name its server');
  });

  it('writes an allow that does name one', () => {
    const { permissions } = toClaudeCodePermissions([
      policy('let-crm-reads', 'allow', ['mcp.crm.read_customer']),
    ]);

    expect(permissions.allow).toEqual(['mcp__crm__read_customer']);
  });
});
