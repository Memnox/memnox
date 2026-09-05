import { describe, expect, it } from 'vitest';
import {
  classOf,
  destructiveVerbs,
  externalStateVerbs,
  hasTag,
  matchVerb,
  UNKNOWN_VERB,
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
});
