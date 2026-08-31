import { DECISION_EFFECT, type ActionRequest } from '@memnox/core';
import { LocalGate } from '@memnox/local-gate';
import { describe, expect, it } from 'vitest';
import type { HookAuthorizer } from '../src/hook-authorizer';
import { HookAuthorizer as RealAuthorizer } from '../src/hook-authorizer';
import {
  GitCredentialSeam,
  parseGitInput,
  GIT_CREDENTIAL_ACTION,
} from '../src/git-credential-seam';
import { ShellSeam, SHELL_EXIT_OK, SHELL_EXIT_WITHHELD } from '../src/shell-seam';

/** Records what it was asked, and answers what it was told to. */
class StubAuthorizer {
  readonly seen: ActionRequest[] = [];
  constructor(
    private readonly verdict: {
      effect: string;
      reason: string;
      alternative?: { action: string; resource?: string; note: string };
      approvalId?: string;
    },
  ) {}
  async authorize(request: ActionRequest): Promise<typeof this.verdict> {
    this.seen.push(request);
    return this.verdict;
  }
}

const as = (stub: StubAuthorizer): HookAuthorizer => stub as unknown as HookAuthorizer;

const allow = { effect: DECISION_EFFECT.ALLOW, reason: 'no rule matched' };

describe('the shell seam', () => {
  it('runs an allowed command unchanged', async () => {
    const stub = new StubAuthorizer(allow);
    const outcome = await new ShellSeam({ authorizer: as(stub) }).gate([
      'npm',
      'test',
      '--watch',
    ]);

    expect(outcome.run).toEqual(['npm', 'test', '--watch']);
    expect(outcome.exitCode).toBe(SHELL_EXIT_OK);
    expect(stub.seen[0]?.action).toBe('shell.execute');
    expect(stub.seen[0]?.target).toBe('npm test --watch');
  });

  it('withholds without rewriting what was asked for', async () => {
    const outcome = await new ShellSeam({
      authorizer: as(
        new StubAuthorizer({
          effect: DECISION_EFFECT.WITHHOLD,
          reason: 'recursive delete',
          alternative: { action: 'shell.execute', note: 'delete one path at a time' },
        }),
      ),
    }).gate(['rm', '-rf', '/']);

    expect(outcome.run).toBeUndefined();
    expect(outcome.exitCode).toBe(SHELL_EXIT_WITHHELD);
    expect(outcome.message).toContain('recursive delete');
    expect(outcome.message).toContain('Instead: shell.execute');
  });

  it('names the approval a person can answer', async () => {
    const outcome = await new ShellSeam({
      authorizer: as(
        new StubAuthorizer({
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'a deploy needs a person',
          approvalId: 'apr_7',
        }),
      ),
    }).gate(['./deploy.sh']);

    expect(outcome.message).toContain('memnox approvals resolve apr_7');
  });

  it('carries the command for the local gate to match on', async () => {
    const stub = new StubAuthorizer(allow);
    await new ShellSeam({ authorizer: as(stub), sessionId: 'ses_1' }).gate(['ls', '-la']);

    expect(stub.seen[0]?.arguments).toEqual({ command: 'ls -la' });
    expect(stub.seen[0]?.sessionId).toBe('ses_1');
  });

  it('refuses an empty command rather than running a shell', async () => {
    const stub = new StubAuthorizer(allow);
    const outcome = await new ShellSeam({ authorizer: as(stub) }).gate([]);

    expect(outcome.exitCode).toBe(SHELL_EXIT_WITHHELD);
    expect(stub.seen).toEqual([]);
  });

  it('withholds a real command against a real rule, with no runtime', async () => {
    const gate = new LocalGate(
      [
        {
          name: 'no-recursive-delete',
          match: { actions: ['shell.execute'], arguments: { command: ['*rm -rf*'] } },
          decision: { effect: DECISION_EFFECT.WITHHOLD, reason: 'recursive delete' },
        },
      ],
      { agentName: 'claude-code' },
    );

    const seam = new ShellSeam({
      authorizer: new RealAuthorizer({ gate, log: () => {} }),
    });

    expect((await seam.gate(['rm', '-rf', 'build'])).run).toBeUndefined();
    expect((await seam.gate(['npm', 'test'])).run).toEqual(['npm', 'test']);
  });
});

describe('parseGitInput', () => {
  it('reads git’s own key=value block', () => {
    expect(
      parseGitInput('protocol=https\nhost=github.com\npath=acme/app.git\n\n'),
    ).toEqual({ protocol: 'https', host: 'github.com', path: 'acme/app.git' });
  });

  /** It has no business carrying one, and a helper that did would be worth stealing. */
  it('drops a password git happened to include', () => {
    const fields = parseGitInput('host=github.com\npassword=hunter2\n');
    expect(fields['password']).toBeUndefined();
    expect(fields['host']).toBe('github.com');
  });

  it('ignores a line that is not a pair', () => {
    expect(parseGitInput('host=github.com\ngarbage\n=novalue\n')).toEqual({
      host: 'github.com',
    });
  });
});

describe('the git credential seam', () => {
  const input = 'protocol=https\nhost=github.com\npath=acme/app.git\n\n';

  it('stays silent on an allowed remote, so the next helper supplies', async () => {
    const stub = new StubAuthorizer(allow);
    const outcome = await new GitCredentialSeam({ authorizer: as(stub) }).gate(input);

    expect(outcome.stdout).toBe('');
    expect(stub.seen[0]?.action).toBe(GIT_CREDENTIAL_ACTION);
    expect(stub.seen[0]?.target).toBe('https://github.com/acme/app.git');
  });

  it('stops git asking anyone when the remote is withheld', async () => {
    const outcome = await new GitCredentialSeam({
      authorizer: as(
        new StubAuthorizer({
          effect: DECISION_EFFECT.WITHHOLD,
          reason: 'this repository is frozen',
        }),
      ),
    }).gate(input);

    expect(outcome.stdout).toBe('quit=1\n');
    expect(outcome.message).toContain('https://github.com/acme/app.git');
    expect(outcome.message).toContain('frozen');
  });

  /** It holds no secrets and can hand none out; that is the whole point of the shape. */
  it('can never emit a credential, whatever the verdict', async () => {
    for (const effect of [
      DECISION_EFFECT.ALLOW,
      DECISION_EFFECT.WITHHOLD,
      DECISION_EFFECT.ESCALATE,
    ]) {
      const outcome = await new GitCredentialSeam({
        authorizer: as(new StubAuthorizer({ effect, reason: 'r' })),
      }).gate(input);

      expect(outcome.stdout).not.toContain('password=');
      expect(outcome.stdout).not.toContain('username=');
    }
  });

  /** Breaking every clone on a network blip is the failure this does not recover from. */
  it('leaves git alone when nobody could be asked, and names what that gives up', async () => {
    const unreachable = new RealAuthorizer({
      client: {
        check: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      } as never,
      log: () => {},
    });

    const outcome = await new GitCredentialSeam({ authorizer: unreachable }).gate(input);

    expect(outcome.stdout).toBe('');
    expect(outcome.message).toContain('unreachable');
    expect(outcome.message).toContain('reachable until it is back');
  });

  it('still stops git when a rule said no, not the network', async () => {
    const outcome = await new GitCredentialSeam({
      authorizer: as(
        new StubAuthorizer({ effect: DECISION_EFFECT.WITHHOLD, reason: 'frozen' }),
      ),
    }).gate(input);
    expect(outcome.stdout).toBe('quit=1\n');
  });

  it('rules on a block that names no host without inventing one', async () => {
    const stub = new StubAuthorizer(allow);
    await new GitCredentialSeam({ authorizer: as(stub) }).gate('protocol=https\n');
    expect(stub.seen[0]?.target).toBeUndefined();
  });
});
