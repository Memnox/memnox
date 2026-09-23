import { describe, expect, it } from 'vitest';
import { agentBehind } from '../src/intercept/actor';

const TERMINAL = [
  ['-zsh'],
  ['/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal'],
];

describe('agentBehind', () => {
  /* The PATH line in .zshrc put a person's own git status under the rules, and a
     registered policy file that had gone missing stopped it outright. */
  it('reads a command typed in a plain terminal as the person, not an agent', () => {
    expect(agentBehind({}, TERMINAL)).toBeNull();
  });

  it('reads the marker Claude Code sets on everything it runs', () => {
    expect(agentBehind({ CLAUDECODE: '1' }, TERMINAL)).toBe('CLAUDECODE');
  });

  it('reads a session memnox run started as an agent', () => {
    expect(agentBehind({ MEMNOX_SESSION: 'ses_1' }, TERMINAL)).toBe('MEMNOX_SESSION');
  });

  it('ignores a marker that is set but empty', () => {
    expect(agentBehind({ CLAUDECODE: '' }, TERMINAL)).toBeNull();
  });

  it('finds an agent binary among the ancestors when nothing is in the environment', () => {
    expect(
      agentBehind({}, [['/bin/zsh', '-c'], ['/opt/homebrew/bin/codex'], ...TERMINAL]),
    ).toBe('codex');
  });

  it('sees through a node launcher to the agent script it runs', () => {
    expect(
      agentBehind({}, [
        ['/bin/sh'],
        ['node', '/usr/local/lib/node_modules/@openai/codex/bin/codex.js'],
      ]),
    ).toBe('codex');
  });

  it('does not read an IDE as an agent, because people type in its terminal too', () => {
    expect(
      agentBehind({}, [['-zsh'], ['/Applications/Cursor.app/Contents/MacOS/Cursor']]),
    ).toBeNull();
  });

  it('does not match an argument that only happens to be an agent name', () => {
    expect(agentBehind({}, [['/usr/bin/vim', '/tmp/x', 'claude']])).toBeNull();
  });
});
