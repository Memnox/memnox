import { describe, expect, it } from 'vitest';
import { resolveAction, resolveShellLine } from '../src/intercept/resolve';
import { takesLease } from '../src/coordination/writes';

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

  it('reads a statement passed to mariadb, mycli and pgcli as their parent client would', () => {
    const drop = resolveAction('mariadb', ['-e', 'DROP DATABASE x']);
    expect(drop.action).toBe('mariadb.drop');
    expect(drop.class).toBe('destructive');
    expect(resolveAction('mariadb', ['--execute=SELECT 1']).class).toBe('read');
    expect(resolveAction('mycli', ['-e', 'TRUNCATE t']).action).toBe('mycli.truncate');
    expect(resolveAction('pgcli', ['-c', 'DROP TABLE t']).class).toBe('destructive');
  });

  it('reads a redis command in either case, after the connection flags', () => {
    for (const line of [
      'redis-cli FLUSHALL',
      'redis-cli flushall',
      'redis-cli -h cache.internal -p 6380 FlushDb',
      'redis-cli -a secret --tls DEL session:1',
      'redis-cli UNLINK k',
    ]) {
      expect(resolve(line).class, line).toBe('destructive');
    }
    expect(resolve('redis-cli SET k v').class).toBe('write');
    expect(resolve('redis-cli CONFIG SET maxmemory 1gb').class).toBe('write');
    expect(resolve('redis-cli get k').class).toBe('read');
    expect(resolve('redis-cli KEYS *').class).toBe('read');
    expect(resolve('redis-cli INFO').class).toBe('read');
    // A bare session is a prompt that can run anything, so it is never read as a read.
    expect(resolve('redis-cli').class).toBe('write');
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

/**
 * A credential rule names `filesystem.read`, and until these existed no seam ever
 * produced that action — so the deny every screen promises about `~/.ssh/id_ed25519`
 * was registered, reported in force, and matched nothing anybody could type.
 */
describe('commands that read a file', () => {
  const env = { HOME: '/Users/me', PWD: '/work/app' };

  it('resolves a reader to filesystem.read on the path it was given', () => {
    const read = resolve('cat ~/.ssh/id_ed25519', env);
    expect(read.action).toBe('filesystem.read');
    expect(read.class).toBe('read');
    expect(read.target).toBe('/Users/me/.ssh/id_ed25519');
  });

  it('names every file, so a second argument cannot carry one past the rule', () => {
    expect(resolve('cat README ~/.npmrc', env).targets).toEqual([
      '/work/app/README',
      '/Users/me/.npmrc',
    ]);
  });

  it('resolves a relative path against where the command ran', () => {
    expect(
      resolve('cat .ssh/id_ed25519', { HOME: '/Users/me', PWD: '/Users/me' }).targets,
    ).toEqual(['/Users/me/.ssh/id_ed25519']);
  });

  it('skips the value of a flag, so a line count is never read as a file', () => {
    expect(resolve('head -n 5 ~/.npmrc', env).targets).toEqual(['/Users/me/.npmrc']);
  });

  it('skips a search pattern, since grep puts it where a file would be', () => {
    expect(resolve('grep secret ~/.aws/credentials', env).targets).toEqual([
      '/Users/me/.aws/credentials',
    ]);
  });

  it('takes the source of a copy, which is how a credential leaves a machine', () => {
    expect(resolve('cp ~/.ssh/id_ed25519 /tmp/x', env).targets).toEqual([
      '/Users/me/.ssh/id_ed25519',
    ]);
  });

  it('is a read, so nothing here ever takes a lease or reads as a conflict', () => {
    expect(takesLease(String(resolve('cat ~/.npmrc', env).class))).toBe(false);
  });
});

/* An awk program's `$i` sits in single quotes, so the line reads and writes nothing; taking
   it for an expansion made it a write to every place the line named, the cd included. */
describe('a line whose only dollar is quoted code', () => {
  it('reads, and writes nowhere', () => {
    const line = `cd ~/work/app && git ls-files --others | awk -F/ '{ for(i=1;i<=NF;i++) if($i=="node_modules"){print $i; next} }' | sort | uniq -c; find . -maxdepth 3 -name .gitignore`;
    const { actions, opaque } = resolveShellLine(line, { HOME: '/Users/me' });

    expect(opaque).toEqual([]);
    expect(actions.filter((each) => each.class === 'write')).toEqual([]);
  });
});
