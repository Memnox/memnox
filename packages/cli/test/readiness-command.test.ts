import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerReadinessCommand } from '../src/commands/readiness.command';
import { runCommand } from './cli-harness';
import { fakeSeams, FakeMachine, HOME, PROJECT } from './machine-harness';

const REFUSES_DEPLOY = `version: 1
policies:
  - name: production-deploy-approval
    description: Production deployments need a human sign-off.
    match:
      actions: ["deploy.*"]
      environments: ["production"]
    decision:
      effect: escalate
      approvers: ["eng-lead"]
`;

/** A machine with an agent, a shell, a checkout and a credential, and no deploy tool. */
const MACHINE = {
  [`${HOME}/.claude.json`]: JSON.stringify({ mcpServers: {} }),
  [`${HOME}/.aws/credentials`]: '[default]\naws_access_key_id = AKIAEXAMPLE',
  [`${PROJECT}/.git`]: '',
};

describe('memnox readiness', () => {
  let dir: string;
  let policyFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memnox-readiness-'));
    policyFile = join(dir, 'memnox.policies.yaml');
    await writeFile(policyFile, REFUSES_DEPLOY, 'utf8');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * The whole point of the command: it answers from the environment rather than from
   * the agent, so a missing tool and a refusing rule are both on the same screen.
   */
  it('separates what the machine holds from what the rule still refuses', async () => {
    const { out } = await runCommand(
      (program, context) =>
        registerReadinessCommand(program, context, () =>
          fakeSeams(FakeMachine.from(MACHINE), { policyFiles: [policyFile] }),
        ),
      ['readiness', 'claude-code', 'deploy.service', 'payments', '--env', 'production'],
    );

    expect(out.text).toContain('HAS');
    expect(out.text).toContain('credentials it can reach');
    expect(out.text).toContain('BUT');
    expect(out.text).toContain('a deploy tool on PATH');
    expect(out.text).toContain('escalate');
    expect(out.text).toContain('NOT AUTHORIZED');
  });

  it('refuses an agent that is not on this machine rather than answering about it', async () => {
    await expect(
      runCommand(
        (program, context) =>
          registerReadinessCommand(program, context, () =>
            fakeSeams(FakeMachine.from(MACHINE)),
          ),
        ['readiness', 'devin', 'deploy.service'],
      ),
    ).rejects.toThrow(/no agent "devin"/);
  });

  /** An action nobody stated needs for is not a satisfied one, and it says so. */
  it('says when nothing is known about what an action needs', async () => {
    const { out } = await runCommand(
      (program, context) =>
        registerReadinessCommand(program, context, () =>
          fakeSeams(FakeMachine.from(MACHINE)),
        ),
      ['readiness', 'claude-code', 'billing.refund', '--json'],
    );

    expect(JSON.parse(out.text).known).toBe(false);
  });

  /**
   * A registered rule file belongs to somebody else's repository and goes stale. The
   * machine half of the answer is still true, and a report that died on it would send
   * the reader back to guessing.
   */
  it('still answers when the rule set will not load, and refuses to call it authorized', async () => {
    const broken = join(dir, 'broken.yaml');
    await writeFile(broken, 'version: 1\npolicies:\n  - name: x\n', 'utf8');

    const { out } = await runCommand(
      (program, context) =>
        registerReadinessCommand(program, context, () =>
          fakeSeams(FakeMachine.from(MACHINE), { policyFiles: [broken] }),
        ),
      ['readiness', 'claude-code', 'repository.read'],
    );

    expect(out.text).toContain('HAS');
    expect(out.text).toContain('would not load');
    expect(out.text).toContain('NOT AUTHORIZED');
  });
});
