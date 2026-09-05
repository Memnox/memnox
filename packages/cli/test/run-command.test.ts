import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { interceptorDirFor } from '@memnox/interceptors';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { plainStyle } from '../src/style';
import {
  environmentFor,
  registerRunCommand,
  SESSION_VAR,
} from '../src/commands/run.command';

const HOME = '/home/dev';

describe('the environment memnox run builds', () => {
  it('puts the interceptors first on PATH, so they are found before the real binary', () => {
    const env = environmentFor({ PATH: '/usr/bin:/bin' }, HOME, 'ses_1', 'memnox-shell');
    expect(env['PATH']).toBe(`${interceptorDirFor(HOME)}:/usr/bin:/bin`);
  });

  it('never adds itself twice', () => {
    const once = environmentFor({ PATH: '/usr/bin' }, HOME, 'ses_1', 'memnox-shell');
    const twice = environmentFor(once, HOME, 'ses_1', 'memnox-shell');
    expect(twice['PATH']).toBe(once['PATH']);
  });

  it('points SHELL at the governed shell, so a Bash tool goes through one', () => {
    expect(environmentFor({}, HOME, 'ses_1', 'memnox-shell')['SHELL']).toBe(
      'memnox-shell',
    );
  });

  it('carries a session id, so one piece of work reads as one timeline', () => {
    expect(environmentFor({}, HOME, 'ses_abc', 'sh')[SESSION_VAR]).toBe('ses_abc');
  });

  it('keeps everything else the caller had', () => {
    const env = environmentFor({ HOME: '/home/dev', TERM: 'xterm' }, HOME, 'ses', 'sh');
    expect(env['TERM']).toBe('xterm');
  });
});

describe('memnox run', () => {
  async function run(args: string[], start: ReturnType<typeof vi.fn>) {
    const out = new RecordedOutput();
    const program = new Command();
    registerRunCommand(program, new CliContext(out, plainStyle), {
      start: start as never,
      home: () => HOME,
      newId: () => 'ses_test',
    });
    await program.parseAsync(args, { from: 'user' });
    return out;
  }

  it('starts the agent with the governed environment', async () => {
    const start = vi.fn(async () => 0);
    const out = await run(['run', '--', 'claude', '--dangerous'], start);

    const [binary, args, env] = start.mock.calls[0] as unknown as [
      string,
      string[],
      NodeJS.ProcessEnv,
    ];
    expect(binary).toBe('claude');
    expect(args).toEqual(['--dangerous']);
    expect(env[SESSION_VAR]).toBe('ses_test');
    expect(out.notes.join('\n')).toContain('ses_test');
  });

  it('hands back the agent’s own exit code, because a wrapper that swallowed it would lie', async () => {
    const start = vi.fn(async () => 42);
    await run(['run', '--', 'claude'], start);
    expect(process.exitCode).toBe(42);
    process.exitCode = 0;
  });

  it('says what to type when no command was named', async () => {
    await expect(
      run(
        ['run'],
        vi.fn(async () => 0),
      ),
    ).rejects.toThrow();
  });
});
