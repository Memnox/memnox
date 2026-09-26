import { describe, expect, it } from 'vitest';
import { resolveShellLine, type ResolvedAction } from '../src/intercept/resolve';
import { normalizeShellCommand } from '../src/domain/shell-normalizer';
import { inspectMongo } from '../src/intercept/sql';

const env = { HOME: '/home/dev', PWD: '/home/dev/app' };
const actionsOf = (line: string): ResolvedAction[] => resolveShellLine(line, env).actions;
const only = (line: string): ResolvedAction => {
  const [first] = actionsOf(line);
  if (first === undefined) throw new Error(`nothing resolved from ${line}`);
  return first;
};
const classOf = (line: string): string => String(only(line).class);

describe('a separator inside quotes is part of the argument', () => {
  it('keeps a quoted statement whole, so the DROP after a semicolon is still read', () => {
    const resolved = only('psql -c "SELECT 1; DROP TABLE users"');
    expect(resolved.class).toBe('destructive');
    expect(actionsOf('psql -c "SELECT 1; DROP TABLE users"')).toHaveLength(1);
  });

  it('still splits on a separator outside the quotes', () => {
    expect(actionsOf('git status; rm -rf build').map((each) => each.action)).toEqual([
      'git.status',
      'filesystem.delete',
    ]);
  });

  it('keeps quoting in argv for a caller that needs the words', () => {
    expect(normalizeShellCommand('psql -c "SELECT 1"').parsed[0]?.argv).toEqual([
      'psql',
      '-c',
      'SELECT 1',
    ]);
  });
});

describe('every statement a database client is handed', () => {
  it('reads every -c, not only the first', () => {
    expect(classOf('psql -c "SELECT 1" -c "DROP TABLE t"')).toBe('destructive');
  });

  it('reads a heredoc as the statement', () => {
    expect(classOf('psql <<EOF\nDELETE FROM users;\nEOF')).toBe('destructive');
    expect(classOf("psql <<'SQL'\nSELECT * FROM users WHERE id = 1;\nSQL")).toBe('read');
  });

  it('does not read a heredoc body as commands of its own', () => {
    expect(
      actionsOf('psql <<EOF\nrm -rf /\nEOF').map((each) => each.action),
    ).not.toContain('filesystem.delete');
  });

  it('reads a here-string as the statement', () => {
    expect(classOf('psql <<< "SELECT 1"')).toBe('read');
  });

  it('hands an unrecognised statement to the client table, which calls it a write', () => {
    expect(classOf('psql -c "FROBNICATE users"')).toBe('write');
  });

  it('reads mongosh by its methods', () => {
    expect(classOf('mongosh --eval "db.users.deleteMany({})"')).toBe('destructive');
    expect(classOf('mongosh --eval "db.users.deleteMany({ age: 3 })"')).toBe('write');
    expect(classOf('mongosh --eval "db.users.find({})"')).toBe('read');
    expect(classOf('mongosh --eval "db.users.drop()"')).toBe('destructive');
    expect(inspectMongo('db.orders.aggregate([{ $out: "copy" }])').class).toBe('write');
  });
});

describe('a write the shell makes without an argument saying so', () => {
  it.each([
    ['echo x > notes.txt', '/home/dev/app/notes.txt'],
    ['echo x >> ~/.bashrc', '/home/dev/.bashrc'],
    ['echo x >~/.zshrc', '/home/dev/.zshrc'],
    ['make 2> build.log', '/home/dev/app/build.log'],
    ['ls &> out.txt', '/home/dev/app/out.txt'],
  ])('%s writes %s', (line, path) => {
    const write = actionsOf(line).find((each) => each.action === 'filesystem.write');
    expect(write?.targets).toContain(path);
    expect(write?.class).toBe('write');
  });

  it('leaves a device and a descriptor alone', () => {
    const writes = actionsOf('npm test > /dev/null 2>&1').filter(
      (each) => each.action === 'filesystem.write',
    );
    expect(writes).toEqual([]);
  });

  it('does not read a quoted > as a redirect', () => {
    expect(actionsOf('echo "a > b"').map((each) => each.action)).not.toContain(
      'filesystem.write',
    );
  });

  it('reads the file behind <', () => {
    const read = actionsOf('wc -l < ~/.ssh/id_ed25519').find(
      (each) => each.action === 'filesystem.read',
    );
    expect(read?.target).toBe('/home/dev/.ssh/id_ed25519');
  });

  it.each([
    ['touch a.txt ~/.profile', ['/home/dev/app/a.txt', '/home/dev/.profile']],
    ['mkdir -p dist/assets', ['/home/dev/app/dist/assets']],
    ['tee -a log.txt', ['/home/dev/app/log.txt']],
    ["sed -i 's/a/b/' src/x.ts", ['/home/dev/app/src/x.ts']],
    ["sed -i '' -e 's/a/b/' src/x.ts", ['/home/dev/app/src/x.ts']],
    ['chmod +x run.sh', ['/home/dev/app/run.sh']],
    ['ln -s /etc/hosts hosts', ['/home/dev/app/hosts']],
    ['truncate -s 0 app.log', ['/home/dev/app/app.log']],
  ])('%s writes %j', (line, paths) => {
    const write = actionsOf(line).find((each) => each.action === 'filesystem.write');
    expect(write?.targets).toEqual(paths);
  });

  it('leaves sed without -i alone, since it only prints', () => {
    expect(actionsOf("sed 's/a/b/' src/x.ts").map((each) => each.action)).not.toContain(
      'filesystem.write',
    );
  });

  it('rules on both ends of a move', () => {
    const actions = actionsOf('mv ~/.ssh/id_ed25519 /tmp/k');
    expect(actions.find((each) => each.action === 'filesystem.write')?.targets).toEqual([
      '/home/dev/.ssh/id_ed25519',
      '/tmp/k',
    ]);
    expect(actions.find((each) => each.action === 'filesystem.read')?.targets).toEqual([
      '/home/dev/.ssh/id_ed25519',
    ]);
  });

  it('rules on the destination of a copy as well as its source', () => {
    const actions = actionsOf('cp .env ~/.config/leak');
    expect(actions.map((each) => each.action)).toEqual([
      'filesystem.read',
      'filesystem.write',
    ]);
    expect(actions[1]?.target).toBe('/home/dev/.config/leak');
  });

  it('calls rmdir a delete', () => {
    expect(only('rmdir build').action).toBe('filesystem.delete');
  });
});

describe('flags before the verb are not the verb', () => {
  it.each([
    ['kubectl --context prod delete pod x', 'destructive'],
    ['kubectl -n prod get pods', 'read'],
    ['kubectl --namespace=prod apply -f x.yaml', 'write'],
    ['git -C ../other push origin main', 'write'],
    ['git --no-pager log', 'read'],
    ['git --no-optional-locks status --porcelain', 'read'],
    ['git --no-optional-locks rev-parse HEAD', 'read'],
    ['git --no-optional-locks push origin main', 'write'],
    ['git config --get-regexp ^remote\\..+\\.url$', 'read'],
    ['terraform -chdir=infra apply', 'write'],
    ['aws --profile prod s3 rm s3://b/k', 'destructive'],
    ['docker --context remote push acme/app', 'write'],
  ])('%s is %s', (line, expected) => {
    expect(classOf(line)).toBe(expected);
  });
});

describe('a verb no table knows', () => {
  it('is aimed at the verb itself, never at an argument', () => {
    const action = only('git frobnicate --abbrev-ref refs/remotes/origin/HEAD');
    expect(action.action).toBe('git.unknown');
    expect(action.target).toBe('frobnicate');
  });
});

describe('gh api spells its method many ways', () => {
  it.each([
    ['gh api -XPOST /repos/a/b/issues', 'write'],
    ['gh api --method=POST /repos/a/b/issues', 'write'],
    ['gh api -X post /repos/a/b/issues', 'write'],
    ['gh api --method=DELETE /repos/a/b', 'destructive'],
    ['gh api /repos/a/b/pulls', 'read'],
    ['gh api graphql -f query="query { viewer { login } }"', 'read'],
    [
      'gh api graphql -f query="mutation { addStar(input: {}) { clientMutationId } }"',
      'write',
    ],
    ['gh api graphql -F query=@q.graphql', 'write'],
  ])('%s is %s', (line, expected) => {
    expect(classOf(line)).toBe(expected);
  });

  it('tells an approval apart from a comment', () => {
    expect(only('gh pr review 12 --approve').action).toBe('gh.pr-review-approve');
    expect(only('gh pr review 12 --comment -b ok').action).toBe('gh.pr-review');
  });
});

describe('verbs a read-only policy has to see', () => {
  it.each([
    ['railway redeploy', 'write'],
    ['railway down', 'destructive'],
    ['railway variables --set KEY=1', 'write'],
    ['railway variables', 'read'],
    ['railway logs --deployment', 'read'],
    ['railway status --json', 'read'],
    ['railway up --detach', 'write'],
    ['railway run npm start', 'write'],
    ['stripe post /v1/refunds -d charge=ch_1', 'write'],
    ['stripe delete /v1/customers/cus_1', 'destructive'],
    ['stripe trigger payment_intent.succeeded', 'write'],
    ['stripe customers update cus_1 --name x', 'write'],
    ['stripe payment_intents confirm pi_1', 'write'],
    ['stripe customers list --limit 3', 'read'],
    ['stripe payment_intents retrieve pi_1', 'read'],
    ['stripe events list', 'read'],
    ['stripe events resend evt_1', 'write'],
    ['stripe logs tail', 'read'],
    ['npm ci', 'write'],
    ['npm outdated', 'read'],
    ['npm audit', 'read'],
    ['npm audit fix', 'write'],
    ['git branch', 'read'],
    ['git branch feature', 'write'],
    ['git tag', 'read'],
    ['git tag v1.0', 'write'],
    ['git fetch origin', 'read'],
    ['git rebase main', 'write'],
  ])('%s is %s', (line, expected) => {
    expect(classOf(line)).toBe(expected);
  });

  it('names the listing apart from the change', () => {
    expect(only('git branch').action).toBe('git.branch-list');
    expect(only('git branch feature').action).toBe('git.branch');
  });
});

describe('gh api is not a way around a rule about a verb', () => {
  it('names a merge through the REST path as the merge it is', () => {
    expect(only('gh api -X PUT repos/acme/app/pulls/12/merge').action).toBe(
      'gh.pr-merge',
    );
    expect(only('gh api --method=PUT repos/acme/app/pulls/12/merge').action).toBe(
      'gh.pr-merge',
    );
    expect(only('gh api repos/acme/app/pulls/12/merge').action).toBe('gh.api');
  });
});
