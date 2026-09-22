import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { interceptorDirFor } from '@memnox/interceptors';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { plainStyle } from '../src/style';
import { environmentFor, registerRunCommand } from '../src/commands/run.command';
import { sandboxed } from '../src/commands/run/sandbox';
import { ENV_AGENT_NAME, LeaseRegistry, SESSION_VAR } from '@memnox/core';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcriptPathFor } from '../src/memnox-paths';

const HOME = '/home/dev';

/** No repository, no proxy started and no profile read, so a run touches nothing real. */
const QUIET = {
  rootOf: () => null,
  egress: { daemonPort: async () => 4321 },
  guard: { exists: () => false },
};

/**
 * Never the real one. Left unstubbed, every `memnox run` in this file took a git
 * milestone in whatever repository the suite was running in — hundreds of refs under
 * `refs/memnox/`, written by a test that was only ever checking an environment
 * variable.
 */
class FakeMilestones {
  readonly taken: { note?: string }[] = [];
  forgotten = 0;

  async take(request: { note?: string }): Promise<{ id: string }> {
    this.taken.push(request);
    return { id: `mst_test${this.taken.length}` };
  }

  async forget(): Promise<string[]> {
    this.forgotten += 1;
    return [];
  }
}

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
  const milestones = new FakeMilestones();
  async function run(args: string[], start: ReturnType<typeof vi.fn>) {
    const out = new RecordedOutput();
    /* A usage error otherwise exits the process and prints to the real stderr, so the
       assertion below could only say "something happened" and the suite wrote to the
       terminal while passing. exitOverride turns it into the message a user reads. */
    const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
    registerRunCommand(program, new CliContext(out, plainStyle), {
      ...QUIET,
      start: start as never,
      home: () => HOME,
      newId: () => 'ses_test',
      // Stated, never read off the runner's PATH: `claude` is installed on some.
      onPath: () => true,
      milestones: (() => milestones) as never,
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

  /* Every seam its children reach reads the name from here, and one that finds
     none reports an anonymous action the control plane cannot put on an agent. */
  it.each([
    ['claude', 'claude-code'],
    ['codex', 'codex-cli'],
    ['cursor-agent', 'cursor'],
  ])('names %s to every seam as %s', async (binary, agent) => {
    const start = vi.fn(async () => 0);
    await run(['run', '--', binary], start);

    const env = (
      start.mock.calls[0] as unknown as [string, string[], NodeJS.ProcessEnv]
    )[2];
    expect(env[ENV_AGENT_NAME]).toBe(agent);
  });

  it('applies retention where the milestone is made, not only when asked', async () => {
    /* Left to `rewind --forget` alone, a machine that starts agents all day reached
       nine hundred refs and a listing nobody could read. */
    const before = milestones.forgotten;
    await run(
      ['run', '--', 'claude'],
      vi.fn(async () => 0),
    );
    // One taken, one pruned: retention runs on the same path that made the milestone.
    expect(milestones.taken.at(-1)?.note).toBe('before claude');
    expect(milestones.forgotten).toBe(before + 1);
  });

  it('hands back the agent’s own exit code, because a wrapper that swallowed it would lie', async () => {
    const start = vi.fn(async () => 42);
    await run(['run', '--', 'claude'], start);
    expect(process.exitCode).toBe(42);
    process.exitCode = 0;
  });

  it('refuses a binary that is not there, and names the one meant', async () => {
    /* `claude-code` is what the scan calls the agent and `claude` is what starts it,
       so this is the first thing a reader types after reading one screen. */
    const out = new RecordedOutput();
    const start = vi.fn(async () => 0);
    const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
    registerRunCommand(program, new CliContext(out, plainStyle), {
      ...QUIET,
      start: start as never,
      home: () => HOME,
      newId: () => 'ses_test',
      onPath: (binary) => binary === 'claude',
      binaryMeantBy: () => 'claude',
      milestones: (() => new FakeMilestones()) as never,
    });

    await expect(
      program.parseAsync(['run', '--', 'claude-code'], { from: 'user' }),
    ).rejects.toThrow(/"claude-code" is not on PATH[\s\S]*memnox run -- claude/);
    // Nothing was set up for a run that never started: no session, no milestone.
    expect(start).not.toHaveBeenCalled();
    expect(out.notes).toEqual([]);
  });

  it('says what to type when no command was named', async () => {
    await expect(
      run(
        ['run'],
        vi.fn(async () => 0),
      ),
    ).rejects.toThrow(/missing required argument 'command'/);
  });
});

describe('the transcript tap', () => {
  const milestones = new FakeMilestones();
  async function run(args: string[], start: ReturnType<typeof vi.fn>) {
    const out = new RecordedOutput();
    const program = new Command();
    registerRunCommand(program, new CliContext(out, plainStyle), {
      ...QUIET,
      start: start as never,
      home: () => HOME,
      newId: () => 'ses_test',
      // Stated, never read off the runner's PATH: `claude` is installed on some.
      onPath: () => true,
      milestones: (() => milestones) as never,
    });
    await program.parseAsync(args, { from: 'user' });
    return out;
  }

  it('is off unless asked for, because it is a copy of what the agent said', async () => {
    const start = vi.fn(async () => 0);
    await run(['run', '--', 'claude'], start);
    expect((start.mock.calls[0] as unknown as unknown[])[3]).toBeUndefined();
  });

  it('keeps it under the data directory, per session', async () => {
    const start = vi.fn(async () => 0);
    const out = await run(['run', '--transcript', '--', 'claude'], start);

    const path = (start.mock.calls[0] as unknown as string[])[3];
    expect(path).toBe(transcriptPathFor(HOME, 'ses_test'));
    expect(path).toContain('.memnox/transcripts');
    expect(out.notes.join('\n')).toContain('transcript');
  });

  it('names the session in the file, so a claim joins the actions it was made about', () => {
    expect(transcriptPathFor(HOME, 'ses_abc')).toContain('ses_abc.log');
  });
});

describe('starting an agent inside the kernel sandbox', () => {
  const mac = { platform: 'darwin', kernel: '23.5.0', exists: () => true };
  const linux = { platform: 'linux', kernel: '6.8.0', exists: () => true };

  it('wraps the command when a profile was written', () => {
    expect(sandboxed(['claude'], '/home/me', true, mac).command).toEqual([
      'sandbox-exec',
      '-f',
      '/home/me/.memnox/guard/memnox.sb',
      'claude',
    ]);
  });

  // No profile means nobody asked for one, and a sandbox denying nothing only adds a process.
  it('leaves the command alone when no profile was written', () => {
    const run = sandboxed(['claude'], '/home/me', true, { ...mac, exists: () => false });
    expect(run.command).toEqual(['claude']);
    expect(run.because).toContain('memnox protect --os-guard');
  });

  it('leaves the command alone when the person said not to', () => {
    expect(sandboxed(['claude'], '/home/me', false, mac).command).toEqual(['claude']);
  });

  it('applies the Landlock ruleset for real where the kernel answers with an ABI', () => {
    const run = sandboxed(['claude'], '/home/me', true, { ...linux, probe: () => 4 });
    expect(run.guard).toBe('landlock');
    expect(run.command).toEqual([
      'python3',
      '/home/me/.memnox/guard/landlock-exec.py',
      '/home/me/.memnox/guard/landlock.json',
      '--',
      'claude',
    ]);
    expect(run.because).toContain('TCP connect');
  });

  it('says plainly when Landlock is there but nothing can apply it', () => {
    const run = sandboxed(['claude'], '/home/me', true, { ...linux, probe: () => null });
    expect(run.command).toEqual(['claude']);
    expect(run.because).toContain('python3 is not here');
  });

  it('says plainly when the kernel has Landlock turned off', () => {
    const run = sandboxed(['claude'], '/home/me', true, { ...linux, probe: () => 0 });
    expect(run.guard).toBeNull();
    expect(run.because).toContain('turned off');
  });

  it('names a kernel too old for Landlock rather than pretending', () => {
    const run = sandboxed(['claude'], '/home/me', true, { ...linux, kernel: '5.4.0' });
    expect(run.command).toEqual(['claude']);
    expect(run.because).toContain('predates Landlock');
  });

  it('holds files only on a kernel whose Landlock cannot hold TCP', () => {
    const run = sandboxed(['claude'], '/home/me', true, { ...linux, probe: () => 3 });
    expect(run.because).toContain('files only');
  });
});

describe('a session that ends holds nothing', () => {
  const NOW = new Date('2026-09-05T10:00:00.000Z');

  async function runWithLeases(
    home: string,
    start: () => Promise<number>,
  ): Promise<RecordedOutput> {
    const out = new RecordedOutput();
    const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
    registerRunCommand(program, new CliContext(out, plainStyle), {
      ...QUIET,
      start: start as never,
      home: () => home,
      newId: () => 'ses_test',
      now: () => NOW,
      onPath: () => true,
      milestones: (() => {
        throw new Error('no repository');
      }) as never,
    });
    await program.parseAsync(['run', '--', 'claude'], { from: 'user' });
    return out;
  }

  it('releases what the session took when the agent exits', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-run-lease-'));
    const registry = new LeaseRegistry(home, () => true);
    await registry.take(
      {
        path: 'src/billing',
        holder: { agent: 'claude-code', sessionId: 'ses_test', pid: process.pid },
      },
      NOW.toISOString(),
    );

    await runWithLeases(home, async () => 0);
    expect(await registry.held(NOW.toISOString())).toEqual([]);
  });

  it('releases them even when the agent crashed, which is when it matters most', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-run-crash-'));
    const registry = new LeaseRegistry(home, () => true);
    await registry.take(
      {
        path: 'src/billing',
        holder: { agent: 'claude-code', sessionId: 'ses_test', pid: process.pid },
      },
      NOW.toISOString(),
    );

    await expect(
      runWithLeases(home, async () => {
        throw new Error('the agent died');
      }),
    ).rejects.toThrow('the agent died');
    expect(await registry.held(NOW.toISOString())).toEqual([]);
  });

  it('leaves the leases of another session alone', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-run-other-'));
    const registry = new LeaseRegistry(home, () => true);
    await registry.take(
      {
        path: 'docs',
        holder: { agent: 'cursor', sessionId: 'ses_other', pid: process.pid },
      },
      NOW.toISOString(),
    );

    await runWithLeases(home, async () => 0);
    expect((await registry.held(NOW.toISOString())).map((l) => l.path)).toEqual(['docs']);
  });
});

/**
 * The note was printed whether or not anything was in that directory, so a run with no
 * wrappers installed reported that shell and git commands were being gated and then
 * gated none of them. It is the screen somebody reads before walking away.
 */
describe('what memnox run says is wired', () => {
  async function runWith(installed: readonly string[]): Promise<RecordedOutput> {
    const out = new RecordedOutput();
    const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
    registerRunCommand(program, new CliContext(out, plainStyle), {
      ...QUIET,
      start: (async () => 0) as never,
      home: () => HOME,
      newId: () => 'ses_test',
      onPath: () => true,
      interceptorsIn: () => installed,
      milestones: (() => new FakeMilestones()) as never,
    });
    await program.parseAsync(['run', '--no-milestone', '--', 'claude'], { from: 'user' });
    return out;
  }

  it('counts what is actually there', async () => {
    const out = await runWith(['git', 'rm', 'curl']);
    expect(out.notes.join('\n')).toContain('3 on PATH from');
  });

  it('says so plainly when none are installed, and names the fix', async () => {
    const said = (await runWith([])).notes.join('\n');
    expect(said).toContain('none installed, so shell and git commands are not gated');
    expect(said).toContain('memnox protect --interceptors');
    // The one thing it must never do is claim a seam it does not have.
    expect(said).not.toContain('on PATH from');
  });
});
