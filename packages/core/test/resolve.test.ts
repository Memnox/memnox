import { describe, expect, it } from 'vitest';
import { resolveAction } from '../src/intercept/resolve';

const argv = (line: string): string[] => line.split(' ').filter((w) => w !== '');
const resolve = (line: string, env: NodeJS.ProcessEnv = {}) => {
  const [binary, ...args] = argv(line);
  return resolveAction(binary as string, args, env);
};

/**
 * One resolver, so a rule written from one screen matches at every other. Two would
 * mean `protect` writing a rule that `policy test` agrees with and the interceptor
 * quietly ignores.
 */
describe('resolving one command line', () => {
  it('reads a database statement rather than the tool', () => {
    expect(resolve('psql -c DROP').action).toBe('psql.drop');
    expect(resolve('psql -c SELECT').class).toBe('read');
  });

  it('gives an unbounded statement its own action, so a rule can name it', () => {
    const [b, ...a] = ['psql', '-c', 'DELETE FROM users'];
    expect(resolveAction(b as string, a).action).toBe('psql.delete-unbounded');

    const bounded = resolveAction('psql', ['-c', 'DELETE FROM users WHERE id = 1']);
    expect(bounded.action).toBe('psql.delete');
    expect(bounded.class).toBe('write');
  });

  it('names the host when the client is pointed at somebody else’s data', () => {
    const resolved = resolveAction('psql', ['-c', 'SELECT 1'], {
      DATABASE_URL: 'postgres://u:pw@db.prod.internal/app',
    });
    expect(resolved.target).toBe('db.prod.internal');
    expect(resolved.because).toContain('db.prod.internal');
    expect(JSON.stringify(resolved)).not.toContain('pw@');
  });

  it('falls through to the verb table for everything else', () => {
    expect(resolve('git push --force').action).toBe('git.push-force');
    expect(resolve('git push origin main').action).toBe('git.push');
    expect(resolve('kubectl get pods').class).toBe('read');
  });

  it('carries the alternative the table wrote, never one invented later', () => {
    expect(resolve('git push --force').alternative).toContain('open a PR');
  });

  it('falls back to the generic classifier for a binary with no table', () => {
    expect(resolve('rm -rf build').action).toBe('filesystem.delete');
    expect(resolve('curl https://example.com').class).toBe('network');
  });

  it('says shell.execute for something nothing recognises, and allows it', () => {
    expect(resolve('frobnicate --hard').action).toBe('shell.execute');
  });

  it('is deterministic — the same line always resolves the same way', () => {
    expect(resolve('git push --force')).toEqual(resolve('git push --force'));
  });
});
