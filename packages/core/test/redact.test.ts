import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../src/domain/redact';
import { plainAsk } from '../src/gate/plain-ask';

/* A command line is the target when nothing narrower was parsed, so these reached the
   control plane, a DM and the ledger rows it keeps with the credential in them. */
describe('what leaves the machine, with its credentials masked', () => {
  it.each([
    ['vercel deploy --token=abcd1234efgh5678', 'vercel deploy --token=[redacted]'],
    ['vercel deploy --token abcd1234efgh5678', 'vercel deploy --token [redacted]'],
    ['PGPASSWORD=hunter2hunter psql -h db', 'PGPASSWORD=[redacted] psql -h db'],
    [
      'DATABASE_URL=postgres://app:s3cr3tpw@db:5432/app pnpm migrate',
      'DATABASE_URL=postgres://app:[redacted]@db:5432/app pnpm migrate',
    ],
    [
      'curl -H "Authorization: Bearer abcdefghijklmnop" https://api.test',
      'curl -H "Authorization: Bearer [redacted]" https://api.test',
    ],
    [
      'git push https://x:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/a/b',
      'git push https://x:[redacted]@github.com/a/b',
    ],
    [
      'export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuv',
      'export OPENAI_API_KEY=[redacted]',
    ],
    [
      'aws configure set aws_access_key_id AKIAABCDEFGHIJKLMNOP',
      'aws configure set aws_access_key_id [redacted]',
    ],
    ['{"api_key": "abcdefgh12345678"}', '{"api_key": "[redacted]"}'],
  ])('masks %s', (input, output) => {
    expect(redactSecrets(input)).toBe(output);
  });

  /* A quoted value used to mask only to its first space, which reads as handled and
     leaves the rest of a passphrase in the row. */
  it.each([
    ['--password="correct horse battery staple"', '--password="[redacted]"'],
    ["--password='correct horse battery staple'", "--password='[redacted]'"],
    ['cmd --token "my secret value"', 'cmd --token "[redacted]"'],
    ['mysql --password "a b c"', 'mysql --password "[redacted]"'],
    ['{"api_key": "abc def ghi"}', '{"api_key": "[redacted]"}'],
    ['PASSWORD="my pass phrase"', 'PASSWORD="[redacted]"'],
    ['--password="don\'t tell"', '--password="[redacted]"'],
    ['--password=\'say "hi" now\'', "--password='[redacted]'"],
    ['mysql --password="a b" --host db', 'mysql --password="[redacted]" --host db'],
  ])('masks every word of %s', (input, output) => {
    expect(redactSecrets(input)).toBe(output);
  });

  it('leaves a quoted value that holds no secret alone', () => {
    expect(redactSecrets('SECRET="x" OTHER="plain text here"')).toBe(
      'SECRET="[redacted]" OTHER="plain text here"',
    );
  });

  it.each([
    'git commit -m "fix the token refresh race"',
    'rm -rf build',
    'author=moise pnpm test',
    'Claude Code wants to delete finish-cloud.patch.',
  ])('leaves %s as it is', (input) => {
    expect(redactSecrets(input)).toBe(input);
  });

  it('masks a credential in the question a person is asked, and in the task beside it', () => {
    const asked = plainAsk(
      {
        agent: 'claude-code',
        operation: 'shell.execute',
        target: 'vercel deploy --prod --token=abcd1234efgh5678',
        reason: 'production deploys are held',
      },
      'ship it, the token is ghp_abcdefghijklmnopqrstuvwxyz0123',
    );
    expect(asked.summary).not.toContain('abcd1234efgh5678');
    expect(asked.task).not.toContain('ghp_');
  });
});
