import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import { POLICY_PACKS } from '@memnox/policy-engine';
import { FakeRuntime, runCli } from './cli-harness';

const AUDIT_PATH = '/v1/audit';

let workspace: string;
let policyFile: string;

const policyYaml = (name: string, effect: string, action: string): string =>
  [
    'version: 1',
    'policies:',
    `  - name: ${name}`,
    '    match:',
    `      actions: ["${action}"]`,
    '    decision:',
    `      effect: ${effect}`,
    '      reason: because',
  ].join('\n');

const auditEvent = (action: string): Record<string, unknown> => ({
  id: `evt_${action}`,
  occurredAt: '2026-07-27T10:00:00.000Z',
  effect: DECISION_EFFECT.ALLOW,
  agentName: 'claude-code',
  action,
  reason: 'no policy matched',
  advisories: [],
});

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'memnox-policy-'));
  policyFile = join(workspace, 'candidate.yaml');
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('memnox policy version', () => {
  it('prints the content version and every policy name', async () => {
    await writeFile(
      policyFile,
      policyYaml('no-prod-deletes', DECISION_EFFECT.WITHHOLD, 'database.delete'),
      'utf8',
    );

    const { out } = await runCli(['policy', 'version', '--file', policyFile]);

    expect(out.text).toMatch(/Version : \w+/);
    expect(out.text).toContain('Policies: 1');
    expect(out.text).toContain('- no-prod-deletes');
  });

  it('gives the same version for the same rule set', async () => {
    await writeFile(
      policyFile,
      policyYaml('a', DECISION_EFFECT.WITHHOLD, 'database.delete'),
      'utf8',
    );
    const first = await runCli(['policy', 'version', '--file', policyFile]);
    const second = await runCli(['policy', 'version', '--file', policyFile]);

    expect(first.out.lines[0]).toBe(second.out.lines[0]);
  });
});

describe('memnox simulate', () => {
  beforeEach(async () => {
    await writeFile(
      policyFile,
      policyYaml('no-prod-deletes', DECISION_EFFECT.WITHHOLD, 'database.delete'),
      'utf8',
    );
  });

  it('takes the candidate file positionally', async () => {
    const runtime = new FakeRuntime().on('GET', AUDIT_PATH, [
      auditEvent('database.delete'),
    ]);

    const { out } = await runCli(['simulate', policyFile], runtime);

    expect(out.text).toContain('Cases evaluated : 1');
  });

  it('says which file it wants rather than printing usage', async () => {
    await expect(runCli(['simulate'])).rejects.toThrow(/memnox simulate/);
  });

  it('is reachable as a top-level command', async () => {
    const runtime = new FakeRuntime().on('GET', AUDIT_PATH, [
      auditEvent('database.delete'),
    ]);

    const { out } = await runCli(['simulate', policyFile], runtime);

    expect(out.text).toContain('STRICTER');
  });

  it('reports what the candidate set would decide differently', async () => {
    const runtime = new FakeRuntime().on('GET', AUDIT_PATH, [
      auditEvent('database.delete'),
      auditEvent('file.read'),
    ]);

    const { out } = await runCli(['simulate', '--file', policyFile], runtime);

    expect(out.text).toContain('Cases evaluated : 2');
    expect(out.text).toContain('Changed         : 1');
    expect(out.text).toContain('STRICTER');
    expect(out.text).toContain('database.delete');
  });

  it('warns loudly when the candidate set is more permissive', async () => {
    const baseline = join(workspace, 'baseline.yaml');
    await writeFile(
      baseline,
      policyYaml('strict', DECISION_EFFECT.WITHHOLD, 'database.delete'),
      'utf8',
    );
    await writeFile(
      policyFile,
      policyYaml('loose', DECISION_EFFECT.ALLOW, 'database.delete'),
      'utf8',
    );
    const runtime = new FakeRuntime().on('GET', AUDIT_PATH, [
      auditEvent('database.delete'),
    ]);

    const { out } = await runCli(
      ['simulate', '--file', policyFile, '--against', baseline],
      runtime,
    );

    expect(out.text).toContain('LOOSER');
    expect(out.text).toContain('become MORE permissive');
  });

  it('says nothing changed when the candidate set decides identically', async () => {
    const runtime = new FakeRuntime().on('GET', AUDIT_PATH, [auditEvent('file.read')]);

    const { out } = await runCli(['simulate', '--file', policyFile], runtime);

    expect(out.text).toContain('No action would be decided differently.');
  });

  /* With no baseline file the comparison runs against no rules at all, so every rule
     in the candidate reads as a change this run would introduce. Silently, that turned
     "nothing changed" into a page of changes nobody made. */
  it('says so when it is comparing against no baseline at all', async () => {
    await writeFile(
      policyFile,
      policyYaml('strict', DECISION_EFFECT.WITHHOLD, 'database.delete'),
      'utf8',
    );
    const runtime = new FakeRuntime().on('GET', AUDIT_PATH, [
      auditEvent('database.delete'),
    ]);

    const { out } = await runCli(
      ['simulate', '--file', policyFile, '--against', join(workspace, 'gone.yaml')],
      runtime,
    );

    const said = out.notes.join('\n');
    expect(said).toContain('comparing against no rules at all');
    expect(said).toContain('--against');
  });

  it('uses the three effects, not the vocabulary that was removed', async () => {
    const runtime = new FakeRuntime().on('GET', AUDIT_PATH, [auditEvent('file.read')]);

    const { out } = await runCli(['simulate', '--file', policyFile], runtime);

    expect(out.text).toContain('allow 1, escalate 0, withhold 0');
    expect(out.text).not.toContain('block');
  });

  it('stops early when there is no history to simulate against', async () => {
    const runtime = new FakeRuntime().on('GET', AUDIT_PATH, []);

    const { out } = await runCli(['simulate', '--file', policyFile], runtime);

    expect(out.text).toBe('No audit history yet — nothing to simulate against.');
  });
});

describe('memnox policy packs', () => {
  it('lists every shipped pack with its size', async () => {
    const { out } = await runCli(['policy', 'packs']);

    for (const pack of POLICY_PACKS) {
      const noun = pack.policies.length === 1 ? 'policy' : 'policies';
      expect(out.text).toContain(`${pack.name}  (${pack.policies.length} ${noun})`);
    }
    expect(out.text).toContain('memnox policy install');
  });
});

describe('memnox policy install', () => {
  const pack = POLICY_PACKS[0]!;

  it('appends a pack and reports each policy it added', async () => {
    const { out } = await runCli(['policy', 'install', pack.name, '--file', policyFile]);

    const written = await readFile(policyFile, 'utf8');
    expect(written).toContain(pack.policies[0]!.name);
    expect(out.text).toContain(`+ ${pack.policies[0]!.name}`);
    expect(out.text).toContain(`Added ${pack.policies.length} policies`);
  });

  it('is idempotent — a second install skips what is already defined', async () => {
    await runCli(['policy', 'install', pack.name, '--file', policyFile]);
    const { out } = await runCli(['policy', 'install', pack.name, '--file', policyFile]);

    expect(out.text).toContain('(already defined)');
    expect(out.text).toContain('Nothing to add.');
  });

  it('writes nothing with --dry-run', async () => {
    const { out } = await runCli([
      'policy',
      'install',
      pack.name,
      '--file',
      policyFile,
      '--dry-run',
    ]);

    expect(out.text).toContain('Dry run — nothing written.');
    await expect(readFile(policyFile, 'utf8')).rejects.toThrow();
  });

  it('rejects a pack name it does not know', async () => {
    await expect(
      runCli(['policy', 'install', 'no-such-pack', '--file', policyFile]),
    ).rejects.toThrow(/unknown pack "no-such-pack"/);
  });
});
