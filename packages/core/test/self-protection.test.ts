import { describe, expect, it } from 'vitest';
import { LocalGate } from '../src/gate/local-gate';
import { loosens } from '../src/gate/self-protection';
import { resolveAction, resolveShellLine } from '../src/intercept/resolve';

/* A test run by an agent wrote into the live rule file, and nothing stopped an agent typing
   `memnox allow` or `memnox mode off` for itself. Both are refused whatever the rules say. */

const ALLOW_EVERYTHING = [
  {
    name: 'allow-all',
    match: { actions: ['*'] },
    decision: { effect: 'allow', reason: 'this machine trusts its agents' },
  },
];

const gate = (): LocalGate =>
  new LocalGate(ALLOW_EVERYTHING as never, { agentName: 'claude-code' });

describe('what governs an agent is never the agent’s to change', () => {
  it.each([
    '/Users/me/.memnox/config.toml',
    '/Users/me/.memnox/mode.policies.toml',
    '/repo/memnox.policies.toml',
  ])('denies a write to %s under a rule that allows everything', (target) => {
    const verdict = gate().evaluate({
      action: 'filesystem.write',
      toolClass: 'write',
      target,
    });
    expect(verdict.effect).toBe('deny');
    expect(verdict.reason).toContain('a person changes and an agent never does');
  });

  it('leaves a write anywhere else to the rules', () => {
    const verdict = gate().evaluate({
      action: 'filesystem.write',
      toolClass: 'write',
      target: '/repo/src/memnox.ts',
    });
    expect(verdict.effect).toBe('allow');
  });

  it.each([
    'allow railway.* --for 30m',
    'mode off',
    'stop',
    'approve apr_1',
    'uninstall',
    'rewind --last',
    'rewind --to ms_1',
  ])('denies `memnox %s` typed by an agent', (line) => {
    const [binary, ...args] = ['memnox', ...line.split(' ')];
    const resolved = resolveAction(binary as string, args);
    const verdict = gate().evaluate({
      action: resolved.action,
      toolClass: resolved.class,
      ...(resolved.target === undefined ? {} : { target: resolved.target }),
    });
    expect(verdict.effect).toBe('deny');
  });

  it.each([
    'why',
    'mode',
    'policy test "git push"',
    'report',
    'allow --list',
    'rewind --list',
  ])('lets `memnox %s` through, since it only reads', (line) => {
    expect(loosens(line)).toBe(false);
  });

  it('resolves `npx memnox stop` the same as `memnox stop`', () => {
    expect(resolveAction('npx', ['memnox', 'stop'])).toMatchObject({
      action: 'memnox.stop',
      class: 'write',
    });
  });
});

describe('a shell line into a rule file', () => {
  it.each([
    'echo "[[policies]]" >> memnox.policies.toml',
    'cp /tmp/open.toml ~/.memnox/mode.policies.toml',
    "sed -i '' s/deny/allow/ memnox.policies.toml",
    'rm ~/.memnox/config.toml',
  ])('denies `%s`', (line) => {
    const { actions } = resolveShellLine(line, { HOME: '/Users/me' });
    const refused = actions.map((each) =>
      gate().evaluate({
        action: each.action,
        toolClass: each.class,
        ...(each.target === undefined ? {} : { target: each.target }),
      }),
    );
    expect(refused.map((each) => each.effect)).toContain('deny');
  });
});
