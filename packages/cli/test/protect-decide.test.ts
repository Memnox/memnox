import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readPolicyDocumentFile, writeAccount } from '@memnox/core';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { plainStyle } from '../src/style';
import { registerProtectCommand } from '../src/commands/protect.command';
import { resolvePolicyFile } from '../src/policy-path';
import { readLocalDecisions } from '../src/sync/local-decisions';

/**
 * `protect --ask` and `--deny` write a rule a person decided here, and on an enrolled
 * machine keep it for the next sync, which offers it to the team as a proposal.
 */
describe('memnox protect --ask and --deny', () => {
  let previous: string;
  let realHome: string | undefined;
  let home: string;

  beforeEach(async () => {
    previous = process.cwd();
    process.chdir(await mkdtemp(join(tmpdir(), 'memnox-decide-')));
    // The registry and the decisions both live in the home directory, never the real one.
    realHome = process.env['HOME'];
    home = await mkdtemp(join(tmpdir(), 'memnox-home-'));
    process.env['HOME'] = home;
  });

  afterEach(() => {
    process.chdir(previous);
    if (realHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = realHome;
  });

  async function protect(...args: string[]): Promise<void> {
    const program = new Command();
    registerProtectCommand(program, new CliContext(new RecordedOutput(), plainStyle));
    await program.parseAsync(['protect', ...args], { from: 'user' });
  }

  it('writes the rule a person decided', async () => {
    await protect('--deny', 'db.drop');

    const document = await readPolicyDocumentFile(resolvePolicyFile());
    expect(document?.policies).toEqual([
      expect.objectContaining({
        name: 'deny-db-drop',
        match: { actions: ['db.drop'] },
        decision: expect.objectContaining({ effect: 'deny' }),
      }),
    ]);
  });

  it('keeps nothing to offer on a machine with no team', async () => {
    await protect('--ask', 'deploy.production');

    expect(await readLocalDecisions(home)).toEqual([]);
  });

  it('keeps the decision for the next sync on an enrolled machine', async () => {
    await writeAccount(home, {
      version: 1,
      baseUrl: 'https://cloud.test',
      workspaceId: 'acme',
      machineId: 'mch_1',
      token: 'machine-token',
      privateKey: generateKeyPairSync('ed25519')
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString(),
      enrolledAt: '2026-09-24T09:00:00.000Z',
    });

    await protect('--ask', 'deploy.production');

    expect(await readLocalDecisions(home)).toEqual([
      expect.objectContaining({ operation: 'deploy.production', effect: 'ask' }),
    ]);
  });
});
