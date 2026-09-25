import { describe, expect, it } from 'vitest';
import {
  classOf,
  destructiveVerbs,
  externalStateVerbs,
  hasTag,
  matchVerb,
  UNKNOWN_VERB,
  verbAction,
  verbForAction,
  VERB_TAG,
} from '../src/verbs/verb-table';
import { verbTableFor, verbTableNames, VERB_TABLES } from '../src/verbs/tables';

const argv = (line: string): string[] => line.split(' ').filter((w) => w !== '');
const classFor = (cli: string, line: string): string =>
  classOf(verbTableFor(cli) as never, argv(line)).class;

describe('matching a command against a verb table', () => {
  it('takes the most specific pattern, not the first one listed', () => {
    // `deploy --prod` must beat `deploy`, or table ordering becomes a security control.
    expect(classFor('vercel', 'deploy')).toBe('write');
    expect(matchVerb(verbTableFor('vercel') as never, argv('deploy'))?.pattern).toBe(
      'deploy',
    );
    expect(
      matchVerb(verbTableFor('vercel') as never, argv('deploy --prod'))?.pattern,
    ).toBe('deploy --prod');
  });

  it('tags a production deploy, and leaves a preview untagged', () => {
    const table = verbTableFor('vercel') as never;
    expect(hasTag(classOf(table, argv('deploy --prod')), VERB_TAG.PRODUCTION)).toBe(true);
    expect(hasTag(classOf(table, argv('deploy')), VERB_TAG.PRODUCTION)).toBe(false);
  });

  it('finds a flag wherever somebody put it', () => {
    expect(classFor('vercel', 'deploy ./site --prod')).toBe('write');
    expect(
      hasTag(
        classOf(verbTableFor('git') as never, argv('push origin main --force')),
        VERB_TAG.PRODUCTION,
      ),
    ).toBe(false);
    expect(classFor('git', 'push origin main --force')).toBe('destructive');
  });

  it('calls an uncovered command unknown rather than safe or dangerous', () => {
    expect(classFor('aws', 'some-new-service frobnicate')).toBe('unknown');
    expect(classOf(verbTableFor('aws') as never, argv('nope')).note).toBe(
      UNKNOWN_VERB.note,
    );
  });

  it.each([
    ['aws', 's3 rb s3://bucket', 'destructive'],
    ['aws', 'iam delete-user --user-name x', 'destructive'],
    ['aws', 'sts get-caller-identity', 'read'],
    ['gh', 'repo delete acme/x', 'destructive'],
    ['gh', 'pr merge 821 --squash', 'write'],
    ['gh', 'pr view 821', 'read'],
    ['kubectl', 'delete namespace prod', 'destructive'],
    ['kubectl', 'apply -f x.yaml', 'write'],
    ['kubectl', 'get pods', 'read'],
    ['terraform', 'destroy', 'destructive'],
    ['terraform', 'plan', 'read'],
    ['docker', 'push acme/app', 'write'],
    ['npm', 'publish', 'write'],
    ['npm', 'unpublish acme', 'destructive'],
    ['stripe', 'refunds create --charge ch_1', 'write'],
    ['git', 'reset --hard HEAD~3', 'destructive'],
    ['git', 'status', 'read'],
  ])('%s %s is %s', (cli, line, expected) => {
    expect(classFor(cli, line)).toBe(expected);
  });

  it('marks reading a secret value as secrets, even though it is a read', () => {
    const verb = classOf(
      verbTableFor('aws') as never,
      argv('secretsmanager get-secret-value --secret-id x'),
    );
    expect(verb.class).toBe('read');
    expect(hasTag(verb, VERB_TAG.SECRETS)).toBe(true);
  });
});

describe('the seed tables', () => {
  it('covers the CLIs the plan names', () => {
    for (const cli of [
      'aws',
      'gcloud',
      'az',
      'gh',
      'kubectl',
      'terraform',
      'docker',
      'vercel',
      'railway',
      'fly',
      'heroku',
      'netlify',
      'psql',
      'mysql',
      'mongosh',
      'npm',
      'stripe',
      'git',
      'playwright',
    ]) {
      expect(verbTableNames(), `${cli} missing`).toContain(cli);
    }
  });

  it('gives every table a headline somebody would repeat out loud', () => {
    for (const table of VERB_TABLES) {
      expect(table.headline.length).toBeGreaterThan(8);
      expect(table.verbs.length).toBeGreaterThan(0);
    }
  });

  it('gives the worst verbs a way forward', () => {
    const forcePush = classOf(
      verbTableFor('git') as never,
      argv('push --force origin main'),
    );
    expect(forcePush.alternative).toContain('open a PR');
  });

  it('separates what changes the world from what only reads it', () => {
    const table = verbTableFor('aws') as never;
    expect(externalStateVerbs(table).length).toBeGreaterThan(0);
    expect(destructiveVerbs(table).every((v) => v.class === 'destructive')).toBe(true);
  });

  it('never records a credential value, only where one lives', () => {
    for (const table of VERB_TABLES) {
      for (const source of table.credential) {
        expect(source.startsWith('~') || /^[A-Z_]+$/.test(source)).toBe(true);
      }
    }
  });

  it('reads a short flag as a cluster, so -fdx is the -fd rule and not unknown', () => {
    const table = verbTableFor('git') as never;
    for (const line of ['clean -fd .', 'clean -fdx .', 'clean -xfd .']) {
      expect(classOf(table, argv(line)).class).toBe('destructive');
    }
    // Case still separates them: `-d` is the safe delete and `-D` is the forced one.
    expect(classOf(table, argv('branch -d feature')).class).toBe('write');
    expect(classOf(table, argv('branch -D feature')).class).toBe('destructive');
  });

  it("matches a flag's value against the flag, not against the next positional", () => {
    const table = verbTableFor('gh') as never;
    expect(classOf(table, argv('api -X DELETE /repos/x/y')).class).toBe('destructive');
    // The same call without the verb stays a read, or every `gh api` would be refused.
    expect(classOf(table, argv('api /repos/x/y')).class).toBe('read');
  });
});

/**
 * An action name is not argv. Splitting it back on `-` matched the wrong verb, so a
 * repository deletion was annotated with the note belonging to the plain read.
 */
describe('finding the verb an action name came from', () => {
  it('picks the verb that produces that exact name', () => {
    expect(verbForAction('gh.api-x-delete', verbTableFor)?.class).toBe('destructive');
    expect(verbForAction('gh.api', verbTableFor)?.class).toBe('read');
    expect(verbForAction('git.clean-fd', verbTableFor)?.class).toBe('destructive');
  });

  it('answers null for a name no table produces', () => {
    expect(verbForAction('git.unknown', verbTableFor)).toBeNull();
    expect(verbForAction('nonsense', verbTableFor)).toBeNull();
  });
});

/* `aws ec2 describe-instances` matched no read, since `describe-**` was held against the
   service name, and most writes matched nothing, so an agent's changes were never asked about. */
describe('aws, by the verb its operation starts with', () => {
  it.each([
    ['ec2 describe-instances', 'read'],
    ['lambda list-functions', 'read'],
    ['s3api get-object --bucket b --key k out', 'read'],
    ['iam get-user', 'read'],
    ['ec2 run-instances --image-id ami-1', 'write'],
    ['lambda update-function-code --function-name f', 'write'],
    ['s3api put-object --bucket b --key k', 'write'],
    ['dynamodb create-table --table-name t', 'write'],
    ['s3 cp ./build s3://site --recursive', 'write'],
    ['s3 sync ./build s3://site', 'write'],
    ['iam attach-user-policy --user-name u', 'write'],
    ['sns publish --message hi', 'communication'],
    ['sqs send-message --queue-url q', 'communication'],
    ['dynamodb delete-table --table-name t', 'destructive'],
    ['s3 rm s3://b/k', 'destructive'],
  ])('aws %s is a %s', (line, expected) => {
    expect(classFor('aws', line)).toBe(expected);
  });
});

/* `gh api` was a read whatever it sent, so a POST through it was never asked about. */
describe('gh api, by what it sends', () => {
  it.each([
    ['api repos/o/r/pulls', 'read'],
    ['api -X GET search/issues -f q=bug', 'read'],
    ['api --method GET search/issues -f q=bug', 'read'],
    ['api -X POST repos/o/r/issues', 'write'],
    ['api --method PATCH repos/o/r', 'write'],
    ['api repos/o/r/issues -f title=t', 'write'],
    ['api repos/o/r/issues -F title=t', 'write'],
    ['api graphql --raw-field query=mutation', 'write'],
    ['api repos/o/r/issues --input body.json', 'write'],
    ['api -X DELETE repos/o/r', 'destructive'],
  ])('gh %s is a %s', (line, expected) => {
    expect(classFor('gh', line)).toBe(expected);
  });

  it('knows the everyday pull request and issue verbs', () => {
    expect(classFor('gh', 'issue create --title t')).toBe('write');
    expect(classFor('gh', 'pr comment 12 --body hi')).toBe('communication');
    expect(classFor('gh', 'issue list')).toBe('read');
    expect(classFor('gh', 'run view 3')).toBe('read');
  });
});

describe('the name each verb is recorded under', () => {
  /* Names dropped every word with a `*`, so `iam delete-**` and `iam **` were both
     `aws.iam`, and `explain` could show the write's note on the delete. */
  it('never gives two verbs of different classes one name', () => {
    for (const table of VERB_TABLES) {
      const classes = new Map<string, string>();
      for (const verb of table.verbs) {
        const name = verbAction(table.name, verb);
        const seen = classes.get(name);
        expect(
          seen === undefined || seen === verb.class,
          `${name} names two classes`,
        ).toBe(true);
        classes.set(name, verb.class);
      }
    }
  });

  it('keeps the stem of a prefix, so a delete and a describe are told apart', () => {
    expect(verbForAction('aws.iam-delete', verbTableFor)?.class).toBe('destructive');
    expect(verbForAction('aws.describe', verbTableFor)?.class).toBe('read');
  });
});
