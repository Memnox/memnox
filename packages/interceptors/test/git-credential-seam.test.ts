import { describe, expect, it } from 'vitest';
import { parseGitInput } from '../src/git-credential-seam';

/**
 * `arguments` reaches the ledger, so what this parser keeps is what ends up on
 * disk. It used to drop two keys by name, which was right for the protocol as it
 * stood: git's credential block is extensible, and `oauth_refresh_token` is a
 * long-lived secret under a key the deny list had never heard of.
 */
describe('what is carried out of git’s credential block', () => {
  it('keeps only what naming the remote needs', () => {
    const fields = parseGitInput(
      [
        'protocol=https',
        'host=github.com',
        'path=acme/payments.git',
        'username=nia',
        '',
      ].join('\n'),
    );

    expect(fields).toEqual({
      protocol: 'https',
      host: 'github.com',
      path: 'acme/payments.git',
      username: 'nia',
    });
  });

  it.each([
    ['password', 'hunter2'],
    ['credential', 'Bearer ghp_live'],
    ['oauth_refresh_token', 'ghr_live_refresh'],
    ['password_expiry_utc', '2099999999'],
    ['anything_git_adds_next_year', 'a-secret-nobody-here-anticipated'],
  ])('drops %s, whatever it is worth', (key, value) => {
    const fields = parseGitInput(`protocol=https\nhost=github.com\n${key}=${value}\n\n`);

    expect(fields[key]).toBeUndefined();
    expect(JSON.stringify(fields)).not.toContain(value);
  });
});
