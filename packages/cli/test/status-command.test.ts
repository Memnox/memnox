import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { registerStatusCommand } from '../src/commands/status.command';
import { DEFAULT_POLICY_FILE } from '../src/defaults';
import { plainStyle } from '../src/style';
import { FakeRuntime } from './cli-harness';

const STORED_TOKEN = 'mnx-stored-token';

const policyFile = (project?: string): string =>
  `${project === undefined ? '' : `project: ${project}\n`}version: 1\npolicies: []\n`;

describe('memnox status', () => {
  let root: string;

  const runStatus = async (
    cwd: string,
    loaded: unknown[] = [],
  ): Promise<RecordedOutput> => {
    const out = new RecordedOutput();
    const runtime = new FakeRuntime()
      .on('GET', '/v1/policies', { version: 'v1', policies: loaded })
      .on('GET', '/v1/approvals', [])
      .on('GET', '/v1/audit', []);
    const context = new CliContext(
      out,
      runtime.transport,
      plainStyle,
      async () => ({ token: STORED_TOKEN }),
      {},
    );

    const program = new Command();
    registerStatusCommand(program, context, () => cwd);
    await program.parseAsync(['status'], { from: 'user' });
    return out;
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'memnox-status-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('points at init when the directory has no policy file', async () => {
    const out = await runStatus(root);

    expect(out.notes.join('\n')).toContain(`No ${DEFAULT_POLICY_FILE} here`);
    expect(out.notes.join('\n')).toContain('memnox init');
  });

  it('names the missing key when project-scoped rules are loaded that cannot match', async () => {
    await writeFile(join(root, DEFAULT_POLICY_FILE), policyFile(), 'utf8');

    const out = await runStatus(root, [{ name: 'scoped', project: 'acme-checkout' }]);

    const notes = out.notes.join('\n');
    expect(notes).toContain('declares no "project:"');
    expect(notes).toContain('1 project-scoped rule(s)');
    expect(notes).not.toContain(`No ${DEFAULT_POLICY_FILE} here`);
  });

  // What every fresh `memnox setup` leaves behind: no project declared, and no
  // rule anywhere scoped to one. Nothing is wrong, so nothing should be flagged.
  it('says nothing when no rule is scoped to a project either', async () => {
    await writeFile(join(root, DEFAULT_POLICY_FILE), policyFile(), 'utf8');

    const out = await runStatus(root, [{ name: 'unscoped' }]);

    expect(out.notes.join('\n')).not.toContain('project:');
  });

  it('reports the project and says nothing about it when one is declared', async () => {
    await writeFile(join(root, DEFAULT_POLICY_FILE), policyFile('acme-checkout'), 'utf8');

    const out = await runStatus(root);

    expect(out.text).toContain('Project   : acme-checkout');
    expect(out.notes.join('\n')).not.toContain('project-scoped rules');
  });
});
