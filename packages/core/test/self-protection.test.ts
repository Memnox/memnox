import { describe, expect, it } from 'vitest';
import { LocalGate } from '../src/gate/local-gate';
import {
  AGENT_HOOK_FILES,
  isProtectedPath,
  namesProtected,
} from '../src/gate/protected-paths';
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

  /* Memnox installs its policy hook into each of these, and protected only Claude Code's.
     So Cursor could edit its own hooks.json and take the hook back out. */
  it.each([
    'sed -i "" /memnox/d ~/.cursor/hooks.json',
    'rm ~/.codex/hooks.json',
    'echo {} > ~/.gemini/settings.json',
    'cp /tmp/empty.json ~/.codeium/windsurf/hooks.json',
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

/* One list, imported by the installer and by the guard, so a file a hook is written into
   cannot be left unprotected by the two drifting apart. */
describe('every file a hook is installed into', () => {
  it.each(AGENT_HOOK_FILES.map((parts) => [parts.join('/')]))(
    '~/%s is a path only a person may write',
    (file) => {
      expect(isProtectedPath(`/Users/me/${file}`)).toBe(true);
      expect(namesProtected(`vi /Users/me/${file}`)).not.toBeNull();
    },
  );

  it('leaves a file beside one of them alone', () => {
    expect(isProtectedPath('/Users/me/.cursor/rules.json')).toBe(false);
    expect(isProtectedPath('/Users/me/.codex/notes.json')).toBe(false);
  });
});

/* Each of these reached ~/.memnox or the hook settings with no argument that looked like
   the path: the target was a link name, a relative file after a `cd`, or code. */
describe('what governs an agent, reached some other way', () => {
  const ruled = (line: string): string[] =>
    resolveShellLine(line, { HOME: '/Users/me' }).actions.map(
      (each) =>
        gate().evaluate({
          action: each.action,
          toolClass: each.class,
          ...(each.target === undefined ? {} : { target: each.target }),
        }).effect,
    );

  it.each([
    'cd ~/.memnox/grants && tee s.json',
    'ln -s ~/.memnox g',
    `python3 -c "open('/Users/me/.memnox/stopped.json','w').write('{}')"`,
    `node -e "require('fs').writeFileSync('/Users/me/.memnox/config.toml','')"`,
    'chmod 000 ~/.memnox/config.toml',
    'sqlite3 ~/.memnox/memnox.db "delete from events"',
    `python3 -c "import json;p='/Users/me/.claude/settings.json';d=json.load(open(p));d['disableAllHooks']=True;json.dump(d,open(p,'w'))"`,
    'echo x > .claude/settings.local.json',
    'H=/Users/me/.memnox; rm -rf $H/config.toml',
    'cat $X/.memnox/policy.toml && rm -rf $X',
    `awk '{ print > "/Users/me/.memnox/config.toml" }' notes.txt`,
    `awk 'BEGIN { system("rm -rf ~/.memnox") }'`,
    'awk -f edit.awk ~/.memnox/config.toml',
    'gawk -i inplace 1 ~/.memnox/config.toml',
  ])('denies `%s`', (line) => {
    expect(ruled(line)).toContain('deny');
  });

  it.each([
    'cat ~/.memnox/daemon.log',
    'grep -r pending ~/.memnox',
    'sqlite3 -readonly ~/.memnox/memnox.db "select count(*) from events"',
    'cat ~/.claude/settings.json',
    // A repository's own fingerprint, read through a variable the line itself set.
    'S=/tmp/work; cat $S/repo/.memnox/code-fingerprint.yaml',
    `grep -rn '~/.memnox/' src | awk '{ print $1 }'`,
  ])('still lets `%s` read', (line) => {
    expect(ruled(line)).not.toContain('deny');
  });

  it('follows a link into ~/.memnox to where it really lands', async () => {
    const { mkdtemp, mkdir, symlink } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'memnox-protect-'));
    await mkdir(join(root, 'home', '.memnox', 'grants'), { recursive: true });
    await mkdir(join(root, 'project'));
    await symlink(join(root, 'home', '.memnox'), join(root, 'project', 'g'));

    const verdict = gate().evaluate({
      action: 'filesystem.write',
      toolClass: 'write',
      target: join(root, 'project', 'g', 'grants', 'session.json'),
    });
    expect(verdict.effect).toBe('deny');
  });
});
