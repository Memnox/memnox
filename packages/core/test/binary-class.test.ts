import { describe, expect, it } from 'vitest';
import {
  classifyBinary,
  COMMAND_CLASS,
  isIntercepted,
  interceptedBinaries,
} from '../src/intercept/binary-class';

const classOf = (binary: string, args: string[]): string | undefined =>
  classifyBinary(binary, args)?.class;

describe('classifying one command from argv', () => {
  it('names every binary the interceptor directory holds', () => {
    expect(interceptedBinaries()).toContain('git');
    expect(interceptedBinaries()).toContain('rm');
    expect(isIntercepted('ls')).toBe(false);
    expect(classifyBinary('ls', ['-la'])).toBeNull();
  });

  it.each([
    [['rm', '-rf', '/'], COMMAND_CLASS.DESTRUCTIVE],
    [['rm', 'note.txt'], COMMAND_CLASS.DESTRUCTIVE],
    [['dd', 'if=/dev/zero', 'of=/dev/disk0'], COMMAND_CLASS.DESTRUCTIVE],
    [['curl', 'https://example.com/x'], COMMAND_CLASS.NETWORK],
    [['wget', 'http://example.com'], COMMAND_CLASS.NETWORK],
    [['ssh', 'prod.internal'], COMMAND_CLASS.NETWORK],
    [['npm', 'install', 'left-pad'], COMMAND_CLASS.PACKAGE_INSTALL],
    [['pnpm', 'add', 'lodash'], COMMAND_CLASS.PACKAGE_INSTALL],
    [['pip', 'install', 'requests'], COMMAND_CLASS.PACKAGE_INSTALL],
    [['npm', 'run', 'test'], COMMAND_CLASS.NORMAL],
  ])('classifies %s', (argv, expected) => {
    const [binary, ...args] = argv as string[];
    expect(classOf(binary as string, args)).toBe(expected);
  });

  it('says why a recursive delete at a root is different from any other delete', () => {
    expect(classifyBinary('rm', ['-rf', '/'])?.because).toContain('filesystem root');
    expect(classifyBinary('rm', ['note.txt'])?.because).toBe('a delete');
  });

  it('names the host a request reaches, never the whole line', () => {
    const verdict = classifyBinary('curl', ['-H', 'Authorization: Bearer sekret', 'https://api.example.com/v1/x']);
    expect(verdict?.target).toBe('api.example.com');
    // The header carried a credential; only the host is ever recorded.
    expect(JSON.stringify(verdict)).not.toContain('sekret');
  });

  it('takes a bare host as well as a URL, because curl does', () => {
    expect(classifyBinary('curl', ['example.com/path'])?.target).toBe('example.com');
  });
});

describe('git, which is most of what an agent does', () => {
  it('treats a force push as destructive and an ordinary one as network', () => {
    expect(classOf('git', ['push', '--force', 'origin', 'main'])).toBe(
      COMMAND_CLASS.DESTRUCTIVE,
    );
    expect(classOf('git', ['push', 'origin', 'main'])).toBe(COMMAND_CLASS.NETWORK);
  });

  it('catches --force-with-lease, which is still a rewrite', () => {
    expect(classOf('git', ['push', '--force-with-lease'])).toBe(
      COMMAND_CLASS.DESTRUCTIVE,
    );
  });

  it('says what a force push actually costs somebody', () => {
    expect(classifyBinary('git', ['push', '-f'])?.because).toContain(
      'somebody else may have pulled',
    );
  });

  it.each([
    [['reset', '--hard', 'HEAD~3'], COMMAND_CLASS.DESTRUCTIVE],
    [['clean', '-fd'], COMMAND_CLASS.DESTRUCTIVE],
    [['fetch', 'origin'], COMMAND_CLASS.NETWORK],
    [['clone', 'https://example.com/r.git'], COMMAND_CLASS.NETWORK],
    [['status'], COMMAND_CLASS.NORMAL],
    [['commit', '-m', 'wip'], COMMAND_CLASS.NORMAL],
    [['log'], COMMAND_CLASS.NORMAL],
    [['diff'], COMMAND_CLASS.NORMAL],
  ])('classifies git %s', (args, expected) => {
    expect(classOf('git', args as string[])).toBe(expected);
  });

  it('names the branch, so a rule can be written about one', () => {
    expect(classifyBinary('git', ['push', 'origin', 'main'])?.target).toBe('origin main');
  });

  it('gives every subcommand a namespaced action a rule can match', () => {
    expect(classifyBinary('git', ['push'])?.action).toBe('git.push');
    expect(classifyBinary('git', ['merge', 'main'])?.action).toBe('git.merge');
    expect(classifyBinary('git', [])?.action).toBe('git.status');
  });
});
