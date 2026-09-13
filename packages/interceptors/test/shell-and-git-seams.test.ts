import { DECISION_EFFECT, type ActionRequest } from '@memnox/core';
import { LocalGate } from '@memnox/core';
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

  it('denies without rewriting what was asked for', async () => {
    const outcome = await new ShellSeam({
      authorizer: as(
        new StubAuthorizer({
          effect: DECISION_EFFECT.DENY,
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
          effect: DECISION_EFFECT.ASK,
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

  it('denies a real command against a real rule, with no runtime', async () => {
    const gate = new LocalGate(
      [
        {
          name: 'no-recursive-delete',
          match: { actions: ['shell.execute'], arguments: { command: ['*rm -rf*'] } },
          decision: { effect: DECISION_EFFECT.DENY, reason: 'recursive delete' },
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

  it('stops git asking anyone when the remote is denied', async () => {
    const outcome = await new GitCredentialSeam({
      authorizer: as(
        new StubAuthorizer({
          effect: DECISION_EFFECT.DENY,
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
      DECISION_EFFECT.DENY,
      DECISION_EFFECT.ASK,
    ]) {
      const outcome = await new GitCredentialSeam({
        authorizer: as(new StubAuthorizer({ effect, reason: 'r' })),
      }).gate(input);

      expect(outcome.stdout).not.toContain('password=');
      expect(outcome.stdout).not.toContain('username=');
    }
  });

  it('still stops git when a rule said no, not the network', async () => {
    const outcome = await new GitCredentialSeam({
      authorizer: as(
        new StubAuthorizer({ effect: DECISION_EFFECT.DENY, reason: 'frozen' }),
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

/**
 * The seam decided and then said nothing, so `why`, `timeline`, `report` and `next`
 * each answered "nothing has been decided on this machine yet" about a machine that
 * had spent the afternoon refusing things.
 */
describe('what the shell seam hands back to be recorded', () => {
  it('names the action that drove the verdict, not the shell it arrived through', async () => {
    const gate = new LocalGate(
      [
        {
          name: 'no-force-push',
          match: { actions: ['git.push-force'] },
          decision: { effect: DECISION_EFFECT.DENY, reason: 'history is shared' },
        },
      ] as never,
      { agentName: 'agent' },
    );
    const outcome = await new ShellSeam({
      authorizer: new RealAuthorizer({ gate, log: () => {} }),
    }).gate(['git push --force origin main']);

    expect(outcome.run).toBeUndefined();
    // `next` counts capabilities, so a row saying only `shell.execute` teaches it nothing.
    expect(outcome.decision.action).toBe('git.push-force');
    expect(outcome.decision.effect).toBe(DECISION_EFFECT.DENY);
    expect(outcome.decision.rule).toBe('no-force-push');
  });

  it('marks a hold that a person allowed, which is what a hand-over is counted from', async () => {
    const gate = new LocalGate(
      [
        {
          name: 'ask-first',
          match: { actions: ['git.commit'] },
          decision: { effect: DECISION_EFFECT.ASK, reason: 'somebody else sees it' },
        },
      ] as never,
      { agentName: 'agent' },
    );
    const outcome = await new ShellSeam({
      authorizer: new RealAuthorizer({ gate, log: () => {} }),
      hold: {
        hold: async () => ({ outcome: 'allowed', answeredBy: 'somebody' }),
      } as never,
    }).gate(['git commit -m fix']);

    expect(outcome.run).toEqual(['git commit -m fix']);
    expect(outcome.decision.asked).toBe(true);
    expect(outcome.decision.effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('records an allow too, or the ledger only ever holds bad news', async () => {
    const outcome = await new ShellSeam({
      authorizer: as(new StubAuthorizer(allow)),
    }).gate(['npm', 'test']);
    expect(outcome.decision.effect).toBe(DECISION_EFFECT.ALLOW);
  });
});

describe('a command naming more than one file', () => {
  it('rules on every one, so a second argument cannot carry a credential past', async () => {
    const gate = new LocalGate(
      [
        {
          name: 'no-key-reads',
          match: { actions: ['filesystem.read'], targets: ['/Users/me/.ssh/**'] },
          decision: { effect: DECISION_EFFECT.DENY, reason: 'that is a credential' },
        },
      ] as never,
      { agentName: 'agent' },
    );
    const seam = new ShellSeam({
      authorizer: new RealAuthorizer({ gate, log: () => {} }),
      env: { HOME: '/Users/me', PWD: '/work' },
    });

    // The denied path is second, which is exactly where it used to go unseen.
    const hidden = await seam.gate(['cat README ~/.ssh/id_ed25519']);
    expect(hidden.run).toBeUndefined();
    expect(hidden.decision.effect).toBe(DECISION_EFFECT.DENY);

    // And an ordinary read still runs, or nobody keeps this turned on.
    expect((await seam.gate(['cat README'])).run).toEqual(['cat README']);
  });
});

/**
 * Every non-allow came back as the reason the rule gave for asking, so a refusal, a
 * slow approver and a machine with nobody to ask all produced one sentence — and the
 * one it read as was "the rule refused you". A person who approved a minute too late
 * watched their agent report that the rule had denied it.
 */
describe('what an agent is told when a hold does not end in yes', () => {
  const askRule = [
    {
      name: 'ask-first',
      match: { actions: ['git.commit'] },
      decision: {
        effect: DECISION_EFFECT.ASK,
        reason: 'somebody else sees the result',
        alternative: { action: 'git', note: 'open a PR instead' },
      },
    },
  ];

  const seamWith = (outcome: string): ShellSeam =>
    new ShellSeam({
      authorizer: new RealAuthorizer({
        gate: new LocalGate(askRule as never, { agentName: 'agent' }),
        log: () => {},
      }),
      hold: { hold: async () => ({ outcome }) } as never,
    });

  it('says a person refused it', async () => {
    const out = await seamWith('denied').gate(['git commit -m fix']);
    expect(out.message).toContain('A person denied');
    // The way forward still rides along, or the refusal is a dead end.
    expect(out.message).toContain('open a PR instead');
  });

  it('says nobody answered, which is not the same as being refused', async () => {
    const out = await seamWith('timed-out').gate(['git commit -m fix']);
    expect(out.message).toContain('Nobody answered in time');
    expect(out.message).not.toContain('A person denied');
  });

  it('says there was nobody to ask, and names how to fix that', async () => {
    const out = await seamWith('unattended').gate(['git commit -m fix']);
    expect(out.message).toContain('no terminal to ask at');
    expect(out.message).toContain('memnox run');
  });

  it('records what happened, so why reads the same as the agent was told', async () => {
    const out = await seamWith('timed-out').gate(['git commit -m fix']);
    expect(out.decision.reason).toContain('Nobody answered in time');
  });
});
