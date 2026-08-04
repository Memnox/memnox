import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT, RISK_LEVEL } from '@memnox/core';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { registerCheckCommand } from '../src/commands/check.command';
import { plainStyle } from '../src/style';
import { FakeRuntime, runCli } from './cli-harness';

const CHECK_PATH = '/v1/actions/check';
/** A directory whose policy file declares a project, written once per run. */
const PROJECT_DIR = mkdtempSync(join(tmpdir(), 'memnox-check-'));
writeFileSync(
  join(PROJECT_DIR, 'memnox.policies.yaml'),
  'project: acme-checkout\nversion: 1\npolicies: []\n',
);

const decision = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  effect: DECISION_EFFECT.BLOCK,
  riskLevel: RISK_LEVEL.CRITICAL,
  reason: 'No AI-initiated destructive database operations in production',
  matchedPolicies: [{ name: 'production-database-protection' }],
  ...over,
});

describe('memnox check', () => {
  it('prints the effect, risk, reason, and matched policies', async () => {
    const runtime = new FakeRuntime().on('POST', CHECK_PATH, decision());

    const { out } = await runCli(
      [
        'check',
        '--token',
        'mnx_test',
        '--action',
        'database.delete',
        '--target',
        'users',
        '--env',
        'production',
      ],
      runtime,
    );

    expect(out.text).toContain('Decision : BLOCK');
    expect(out.text).toContain(`Risk     : ${RISK_LEVEL.CRITICAL}`);
    expect(out.text).toContain('No AI-initiated destructive database operations');
    expect(out.text).toContain('Policies : production-database-protection');
  });

  it('sends the action, target, and environment the flags describe', async () => {
    const runtime = new FakeRuntime().on('POST', CHECK_PATH, decision());

    await runCli(
      [
        'check',
        '--token',
        'mnx_test',
        '--action',
        'deploy.production',
        '--target',
        'api',
        '--env',
        'production',
        '--session',
        'sess-1',
      ],
      runtime,
    );

    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0]?.body).toMatchObject({
      action: 'deploy.production',
      target: 'api',
      environment: 'production',
      sessionId: 'sess-1',
    });
  });

  it('authenticates with the agent token, not an admin token', async () => {
    const runtime = new FakeRuntime().on('POST', CHECK_PATH, decision());

    await runCli(['check', '--token', 'mnx_agent', '--action', 'file.read'], runtime);

    expect(runtime.requests[0]?.authorization).toBe('Bearer mnx_agent');
  });

  it('surfaces the approval id when one is raised', async () => {
    const runtime = new FakeRuntime().on(
      'POST',
      CHECK_PATH,
      decision({
        effect: DECISION_EFFECT.REQUIRE_APPROVAL,
        approvalId: 'apr_42',
        matchedPolicies: [],
      }),
    );

    const { out } = await runCli(
      ['check', '--token', 'mnx_test', '--action', 'deploy.production'],
      runtime,
    );

    expect(out.text).toContain('Decision : REQUIRE_APPROVAL');
    expect(out.text).toContain('Approval : apr_42');
    expect(out.text).not.toContain('Policies :');
  });

  it('fails loudly when the runtime rejects the request', async () => {
    const runtime = new FakeRuntime().on('POST', CHECK_PATH, { error: 'bad token' }, 401);

    await expect(
      runCli(['check', '--token', 'nope', '--action', 'file.read'], runtime),
    ).rejects.toThrow(/401|failed/i);
  });

  it('uses the token memnox setup stored when no --token is given', async () => {
    const runtime = new FakeRuntime().on('POST', CHECK_PATH, decision());
    const out = new RecordedOutput();
    const program = new Command();
    registerCheckCommand(
      program,
      new CliContext(out, runtime.transport, plainStyle, async () => ({
        token: 'mnx_stored',
        url: 'http://127.0.0.1:7466',
      })),
    );

    await program.parseAsync(['check', '--action', 'file.read'], { from: 'user' });

    expect(runtime.requests[0]?.authorization).toBe('Bearer mnx_stored');
  });

  it('says how to get a token rather than sending an unauthenticated request', async () => {
    const runtime = new FakeRuntime().on('POST', CHECK_PATH, decision());
    const out = new RecordedOutput();
    const program = new Command();
    registerCheckCommand(
      program,
      new CliContext(out, runtime.transport, plainStyle, async () => ({}), {}),
    );

    await expect(
      program.parseAsync(['check', '--action', 'file.read'], { from: 'user' }),
    ).rejects.toThrow(/memnox setup/);
    expect(runtime.requests).toHaveLength(0);
  });

  it('points at the approval workflow when one is raised', async () => {
    const runtime = new FakeRuntime().on(
      'POST',
      CHECK_PATH,
      decision({ effect: DECISION_EFFECT.REQUIRE_APPROVAL, approvalId: 'apr_7' }),
    );

    const { out } = await runCli(
      ['check', '--token', 'mnx_test', '--action', 'deploy.production'],
      runtime,
    );

    // Hints ride the note channel so the verdict stays pipeable.
    expect(out.notes.join('\n')).toContain('memnox approve apr_7');
    expect(out.text).not.toContain('memnox approve');
  });

  it('scopes the request to the project the working directory declares', async () => {
    const runtime = new FakeRuntime().on('POST', CHECK_PATH, decision());
    const out = new RecordedOutput();
    const program = new Command();
    registerCheckCommand(
      program,
      new CliContext(out, runtime.transport, plainStyle, async () => ({
        token: 'mnx_stored',
      })),
      () => PROJECT_DIR,
    );

    await program.parseAsync(['check', '--action', 'repository.force_push'], {
      from: 'user',
    });

    // A project-scoped rule is invisible to a request that names no project.
    expect(runtime.requests[0]?.body).toMatchObject({ projectId: 'acme-checkout' });
  });

  it('lets --project override what the directory declares', async () => {
    const runtime = new FakeRuntime().on('POST', CHECK_PATH, decision());
    const out = new RecordedOutput();
    const program = new Command();
    registerCheckCommand(
      program,
      new CliContext(out, runtime.transport, plainStyle, async () => ({
        token: 'mnx_stored',
      })),
      () => PROJECT_DIR,
    );

    await program.parseAsync(
      ['check', '--action', 'file.read', '--project', 'other-project'],
      { from: 'user' },
    );

    expect(runtime.requests[0]?.body).toMatchObject({ projectId: 'other-project' });
  });
});
