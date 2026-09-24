import { describe, expect, it } from 'vitest';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { plainStyle } from '../src/style';
import { buildProgram } from '../src/program';
import { SHORT_HELP_FOOTER } from '../src/help';

/**
 * The front page is the handful of commands a person types at a terminal, because the
 * rest happens in the agent session. Every other command stays wired, and `help --all`
 * lists them, which is also what the client's command coverage check reads.
 */

const SHORT = ['setup', 'status', 'rewind', 'doctor', 'stop', 'start', 'update', 'login'];

async function helpFor(args: string[]): Promise<string> {
  const program = buildProgram(new CliContext(new RecordedOutput(), plainStyle));
  let written = '';
  program.configureOutput({
    writeOut: (text) => {
      written += text;
    },
  });
  program.exitOverride();
  try {
    await program.parseAsync(args, { from: 'user' });
  } catch {
    // `--help` exits through the override once it has written, which is the run under test.
  }
  return written;
}

function listed(help: string): string[] {
  const section = help.split('Commands:')[1] ?? '';
  return [...section.matchAll(/^ {2}([a-z][\w-]*)/gm)].map((match) => match[1] ?? '');
}

describe('memnox --help', () => {
  it('lists exactly the short set, in the order a person reaches for them', async () => {
    const help = await helpFor(['--help']);

    expect(listed(help)).toEqual(SHORT);
    expect(help).toContain(SHORT_HELP_FOOTER.trim());
  });

  it('lists every command under help --all, the hidden ones still wired', async () => {
    const help = await helpFor(['help', '--all']);
    const all = listed(help);

    for (const name of [
      ...SHORT,
      'scan',
      'agents',
      'why',
      'timeline',
      'protect',
      'mcp',
    ]) {
      expect(all).toContain(name);
    }
    expect(help).not.toContain(SHORT_HELP_FOOTER.trim());
  });

  it('still describes one command that is off the front page', async () => {
    const help = await helpFor(['help', 'timeline']);

    expect(help).toContain('Usage: memnox timeline');
  });
});
