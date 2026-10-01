import { describe, expect, it } from 'vitest';
import {
  quoteShellWords,
  splitWithSeparators,
  tokenizeQuoted,
} from '../src/domain/shell-words';

const ARGVS: readonly (readonly string[])[] = [
  ['rm', '-rf', 'my dir'],
  ['echo', 'a; rm x'],
  ['echo', '$HOME', '$(rm -rf ~)', '`whoami`'],
  ['printf', "it's", '"quoted"', 'mixed \'single\' and "double"'],
  ['grep', 'a|b', 'x && y', 'p || q', 'line\nbreak'],
  ['ls', '', '*.ts', '~/.ssh', 'a=b'],
];

describe('quoting argv into one line', () => {
  it.each(ARGVS)('parses back to the argv it was given: %j', (...argv) => {
    const line = quoteShellWords(argv);

    expect(splitWithSeparators(line)).toHaveLength(1);
    expect(tokenizeQuoted(line).map((token) => token.text)).toEqual(argv);
  });

  it('leaves a plain word as it was written', () => {
    expect(quoteShellWords(['rm', '-rf', './build'])).toBe('rm -rf ./build');
  });
});
