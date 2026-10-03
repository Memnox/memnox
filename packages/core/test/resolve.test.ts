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

  it('gives an unbounded statement its own action, so a rule can name it', () => {
    const [b, ...a] = ['psql', '-c', 'DELETE FROM users'];
    expect(resolveAction(b as string, a).action).toBe('psql.delete-unbounded');

    const bounded = resolveAction('psql', ['-c', 'DELETE FROM users WHERE id = 1']);
    expect(bounded.action).toBe('psql.delete');
    expect(bounded.class).toBe('write');
  });

  it('reads every statement on its own, so a WHERE in one does not bound the next', () => {
    const second = resolveAction('psql', [
      '-c',
      'DELETE FROM a WHERE id=1; DELETE FROM b',
    ]);
    expect(second.action).toBe('psql.delete-unbounded');
    expect(second.class).toBe('destructive');

    const split = resolveAction('psql', [
      '-c',
      'SELECT 1 WHERE true',
      '-c',
      'UPDATE users SET admin=true',
    ]);
    expect(split.action).toBe('psql.update-unbounded');
    expect(split.class).toBe('destructive');
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

  it('resolves a kubectl short resource name to the same action as the long one', () => {
    const cases: [string, string][] = [
      ['kubectl delete ns prod', 'kubectl.delete-namespace'],
      ['kubectl delete namespaces prod', 'kubectl.delete-namespace'],
      ['kubectl delete ns/prod', 'kubectl.delete-namespace'],
      ['kubectl -n prod delete ns/a ns/b', 'kubectl.delete-namespace'],
      ['kubectl delete deploy api', 'kubectl.delete-deployment'],
      ['kubectl delete deployments api', 'kubectl.delete-deployment'],
      ['kubectl delete pvc data', 'kubectl.delete-pvc'],
      ['kubectl delete deployments.apps/api', 'kubectl.delete-deployment'],
      ['kubectl delete persistentvolumeclaim data', 'kubectl.delete-pvc'],
      ['kubectl delete persistentvolumeclaims/data', 'kubectl.delete-pvc'],
    ];
    for (const [line, action] of cases) {
      expect(resolve(line).action, line).toBe(action);
      expect(resolve(line).class, line).toBe('destructive');
    }
    expect(resolve('kubectl delete ns/a ns/b').target).toBe('b');
    expect(resolve('kubectl delete pod ns').action).toBe('kubectl.delete');
    expect(resolve('kubectl apply -f deploy/app.yaml').action).toBe('kubectl.apply');
    expect(resolve('kubectl cp ns/web:/tmp/a ./a').target).toBe('./a');
    expect(resolve('kubectl delete pvc/data').target).toBe('data');
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
