import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT, HOLD_ANSWER, HoldService, LocalGate } from '@memnox/core';
import {
  installInterceptors,
  interceptorDirFor,
  invokedAs,
  realPath,
  removeInterceptors,
  resolveReal,
  ruleOnCommand,
} from '../src/index';

const home = (): Promise<string> => mkdtemp(join(tmpdir(), 'memnox-int-'));
const log = (): void => {};

function gate(effect: string, action: string): LocalGate {
  return new LocalGate(
    [
      {
        name: 'no-force-push',
        match: { actions: [action] },
        decision: {
          effect: effect as never,
          reason: 'history is shared',
          alternative: { action: 'git.push', resource: 'a branch', note: 'open a PR' },
        },
      } as never,
    ],
    { agentName: 'claude-code' },
  );
}

describe('the interceptor runtime', () => {
  it('allows anything no rule covers, and still names what it was', async () => {
    const outcome = await ruleOnCommand('git', ['status'], { log });
    expect(outcome.allowed).toBe(true);
    expect(outcome.action).toBe('git.status');
    expect(outcome.class).toBe('normal');
  });

  it('denies what a rule denies, and names a way forward', async () => {
    const outcome = await ruleOnCommand('git', ['push', '--force'], {
      gate: gate(DECISION_EFFECT.DENY, 'git.push'),
      log,
    });
    expect(outcome.allowed).toBe(false);
    expect(outcome.message).toContain('history is shared');
    expect(outcome.message).toContain('Instead: git.push a branch');
    // The reason names what the command actually was, not just the rule.
    expect(outcome.message).toContain('force push rewrites history');
  });

  it('holds an ASK and proceeds when a person allows it', async () => {
    const hold = new HoldService({ ask: async () => HOLD_ANSWER.ONCE });
    const outcome = await ruleOnCommand('rm', ['-rf', 'build'], {
      gate: gate(DECISION_EFFECT.ASK, 'filesystem.delete'),
      hold,
      log,
    });
    expect(outcome.allowed).toBe(true);
  });

  it('denies an ASK when nobody can be asked, and says how to fix that', async () => {
    const outcome = await ruleOnCommand('rm', ['-rf', 'build'], {
      gate: gate(DECISION_EFFECT.ASK, 'filesystem.delete'),
      log,
    });
    expect(outcome.allowed).toBe(false);
    expect(outcome.message).toContain('memnox run');
  });

  it('records a digest of the arguments and never the arguments', async () => {
    const outcome = await ruleOnCommand(
      'curl',
      ['-H', 'Authorization: Bearer sekret', 'https://x.example'],
      { log },
    );
    expect(outcome.argsDigest).toHaveLength(16);
    expect(JSON.stringify({ digest: outcome.argsDigest })).not.toContain('sekret');
  });

  it('knows which name it was invoked as, since one binary serves every entry', () => {
    expect(invokedAs('/home/dev/.memnox/bin/git')).toBe('git');
    expect(invokedAs('rm')).toBe('rm');
  });
});

describe('finding the real binary', () => {
  it('takes our own directory off PATH, or the interceptor would exec itself', () => {
    const ours = interceptorDirFor('/home/dev');
    const path = `${ours}:/usr/bin:/bin`;
    expect(realPath(path, '/home/dev')).toBe('/usr/bin:/bin');
  });

  it('finds the first match along what is left', () => {
    const exists = (p: string): boolean => p === '/usr/bin/git';
    expect(resolveReal('git', '/nope:/usr/bin', exists)).toBe('/usr/bin/git');
    expect(resolveReal('nothing', '/usr/bin', exists)).toBeNull();
  });
});

describe('installing the interceptors', () => {
  it('writes one executable per intercepted binary and prints the PATH line', async () => {
    const dir = await home();
    const report = await installInterceptors(dir, '/usr/local/bin/memnox-intercept');

    expect(report.installed).toContain('git');
    expect(report.installed).toContain('rm');
    expect(report.pathLine).toContain(interceptorDirFor(dir));

    const names = await readdir(report.directory);
    expect(names.sort()).toEqual([...report.installed].sort());

    const mode = (await stat(join(report.directory, 'git'))).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('hands the binary the name it stands in for', async () => {
    const dir = await home();
    await installInterceptors(dir, '/usr/local/bin/memnox-intercept');
    const script = await readFile(join(interceptorDirFor(dir), 'git'), 'utf8');

    expect(script).toContain('exec "/usr/local/bin/memnox-intercept" "git" "$@"');
    // Somebody reading the file has to be told how to undo it.
    expect(script).toContain('memnox uninstall');
  });

  it('removes every one, so the machine goes back as it was', async () => {
    const dir = await home();
    await installInterceptors(dir, '/x/memnox-intercept');
    const removed = await removeInterceptors(dir);

    expect(removed.length).toBeGreaterThan(0);
    await expect(readdir(interceptorDirFor(dir))).rejects.toThrow();
  });

  it('says nothing was removed when nothing was installed', async () => {
    expect(await removeInterceptors(await home())).toEqual([]);
  });
});
