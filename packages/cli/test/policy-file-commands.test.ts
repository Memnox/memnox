import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import { runCli } from './cli-harness';

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'memnox-cli-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('memnox init', () => {
  it('writes a starter policy file and points at the next command', async () => {
    const file = join(workspace, 'memnox.policies.yaml');

    const { out } = await runCli(['init', '--file', file]);

    expect(await readFile(file, 'utf8')).toContain('production-database-protection');
    expect(out.text).toContain(`Created ${file}`);
    // Guidance is commentary, so it goes to stderr and never pollutes a pipe.
    expect(out.notes.join('\n')).toContain('memnox serve');
  });

  it('steers a first run into monitor mode rather than straight to blocking', async () => {
    const file = join(workspace, 'memnox.policies.yaml');

    const { out } = await runCli(['init', '--file', file]);

    expect(out.notes.join('\n')).toContain('--enforcement monitor');
  });

  it('refuses to overwrite an existing policy file', async () => {
    const file = join(workspace, 'memnox.policies.yaml');
    await writeFile(file, 'version: 1\npolicies: []\n', 'utf8');

    await expect(runCli(['init', '--file', file])).rejects.toThrow(
      /already exists — refusing to overwrite/,
    );
    expect(await readFile(file, 'utf8')).toBe('version: 1\npolicies: []\n');
  });
});

describe('memnox validate', () => {
  it('lists every policy and its effect', async () => {
    const file = join(workspace, 'policies.yaml');
    await runCli(['init', '--file', file]);

    const { out } = await runCli(['validate', file]);

    expect(out.text).toContain('is valid — 4 policy(ies)');
    expect(out.text).toContain(
      `- production-database-protection → ${DECISION_EFFECT.WITHHOLD}`,
    );
    expect(out.text).toContain(
      `- production-deploy-approval → ${DECISION_EFFECT.ESCALATE}`,
    );
  });

  it('rejects a policy file that is not valid YAML', async () => {
    const file = join(workspace, 'broken.yaml');
    await writeFile(file, 'policies: [unclosed\n', 'utf8');

    await expect(runCli(['validate', file])).rejects.toThrow();
  });
});
