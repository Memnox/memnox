import { describe, expect, it } from 'vitest';
import { ancestorsOf } from '../src/process-ancestry';

const LISTING = `
    1     0 /sbin/launchd
  100     1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal
  200   100 -zsh
  300   200 claude --resume
  400   300 /bin/zsh -c git status
`;

describe('ancestorsOf', () => {
  it('walks from the process to the top, nearest first', () => {
    expect(ancestorsOf(400, () => LISTING)).toEqual([
      ['/bin/zsh', '-c', 'git', 'status'],
      ['claude', '--resume'],
      ['-zsh'],
      ['/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal'],
    ]);
  });

  it('is empty rather than failing when ps cannot be run', () => {
    expect(
      ancestorsOf(400, () => {
        throw new Error('ps: not found');
      }),
    ).toEqual([]);
  });

  it('stops on a cycle instead of looping', () => {
    expect(ancestorsOf(5, () => '5 6 a\n6 5 b\n')).toHaveLength(32);
  });
});
