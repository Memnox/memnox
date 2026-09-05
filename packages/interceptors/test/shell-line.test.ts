import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DECISION_EFFECT, LocalGate, type ActionRequest } from '@memnox/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HookAuthorizer } from '../src/hook-authorizer';
import { HookAuthorizer as RealAuthorizer } from '../src/hook-authorizer';
import { ShellSeam, SHELL_EXIT_OK, SHELL_EXIT_WITHHELD } from '../src/shell-seam';
import {
  FALLBACK_SHELL,
  realShell,
  shellInvocation,
  SHELL_MODE,
} from '../src/shell-invocation';

/** Records what it was asked, so a test can assert which actions reached the gate. */
class Recorder {
  readonly seen: ActionRequest[] = [];
  async authorize(request: ActionRequest): Promise<{ effect: string; reason: string }> {
    this.seen.push(request);
    return { effect: DECISION_EFFECT.ALLOW, reason: 'no rule matched' };
  }
}

const as = (stub: Recorder): HookAuthorizer => stub as unknown as HookAuthorizer;

describe('what the shell rules on', () => {
  /* `protect --for gh` writes rules named `gh.pr-merge`, and `explain gh` promises
     they govern. Ruling only on the raw line meant none of them could ever fire. */
  it('resolves each command to the action the verb tables name', async () => {
    const stub = new Recorder();
    await new ShellSeam({ authorizer: as(stub) }).gate(['gh', 'pr', 'merge', '12']);

    expect(stub.seen.map((request) => request.action)).toContain('gh.pr-merge');
  });

  it('rules on every command in a chain, not only the first', async () => {
    const stub = new Recorder();
    await new ShellSeam({ authorizer: as(stub) }).gate([
      'gh',
      'pr',
      'merge',
      '12',
      '&&',
      'vercel',
      'deploy',
      '--prod',
    ]);

    const actions = stub.seen.map((request) => request.action);
    expect(actions).toContain('gh.pr-merge');
    expect(actions).toContain('vercel.deploy-prod');
  });

  it('still rules on the whole line, so a shell.execute pattern keeps firing', async () => {
    const stub = new Recorder();
    await new ShellSeam({ authorizer: as(stub) }).gate(['rm', '-rf', './build']);

    expect(stub.seen[0]?.action).toBe('shell.execute');
    expect(stub.seen[0]?.target).toBe('rm -rf ./build');
  });
});

describe('a line whose commands disagree', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memnox-shell-line-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /* The worst command in a line decides it. Taking the last verdict would let anybody
     append a harmless command to a denied one and walk straight through. */
  it('is decided by its worst command, wherever it sits in the line', async () => {
    const file = join(dir, 'rules.yaml');
    await writeFile(
      file,
      `version: 1
policies:
  - name: no-merging
    match: { actions: ["gh.pr-merge"] }
    decision: { effect: deny, reason: merges are people's work }
`,
      'utf8',
    );
    const seam = new ShellSeam({
      authorizer: new RealAuthorizer({
        gate: await LocalGate.fromFiles([file], { agentName: 'test' }),
        log: () => {},
      }),
    });

    const denied = await seam.gate(['gh', 'pr', 'merge', '12', '&&', 'echo', 'done']);
    const allowed = await seam.gate(['echo', 'done']);

    expect(denied.exitCode).toBe(SHELL_EXIT_WITHHELD);
    expect(denied.message).toContain("merges are people's work");
    expect(allowed.exitCode).toBe(SHELL_EXIT_OK);
  });
});

describe('how a shell was invoked', () => {
  /* `memnox run` sets this binary as SHELL, and an agent's Bash tool then calls it
     `$SHELL -c "<line>"`. Reading argv as a command made that `spawn -c`. */
  it('reads the -c form every shell is called with', () => {
    const invocation = shellInvocation(['-c', 'git push --force']);

    expect(invocation.mode).toBe(SHELL_MODE.COMMAND);
    expect(invocation.line).toBe('git push --force');
  });

  it('reads a login or interactive shell asked to run one line', () => {
    expect(shellInvocation(['-lc', 'echo hi']).line).toBe('echo hi');
    expect(shellInvocation(['-lc', 'echo hi']).flags).toEqual([]);
  });

  it('keeps the flags that came before -c, so the real shell starts as asked', () => {
    expect(shellInvocation(['-l', '-c', 'echo hi']).flags).toEqual(['-l']);
  });

  it('still reads the argv form a person or a test drives it with', () => {
    expect(shellInvocation(['--', 'npm', 'test']).argv).toEqual(['npm', 'test']);
  });

  it('treats no command as a shell somebody wants to type into', () => {
    expect(shellInvocation([]).mode).toBe(SHELL_MODE.INTERACTIVE);
  });
});

describe('the shell handed the command on', () => {
  /* `memnox run` overwrites SHELL. Reading it back here would make the wrapper exec
     itself for ever — the interceptor fork bomb, in a place nobody would look. */
  it('is never this binary, whatever SHELL says', () => {
    expect(realShell({ SHELL: '/usr/local/bin/memnox-shell' }, 'memnox-shell')).toBe(
      FALLBACK_SHELL,
    );
    expect(
      realShell(
        { MEMNOX_REAL_SHELL: '/bin/zsh', SHELL: '/x/memnox-shell' },
        'memnox-shell',
      ),
    ).toBe('/bin/zsh');
  });

  it('falls back to the shell every machine has', () => {
    expect(realShell({}, 'memnox-shell')).toBe(FALLBACK_SHELL);
  });
});
