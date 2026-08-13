import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import type { Policy } from '@memnox/policy-engine';
import { LocalGate } from '../src/index';

const gate = (policies: Policy[]): LocalGate =>
  new LocalGate(policies, { agentName: 'mcp:github' });

const blockRecursiveDelete: Policy = {
  name: 'no-rm-rf',
  match: { actions: ['mcp.*'], arguments: { command: ['*rm -rf*'] } },
  decision: { effect: DECISION_EFFECT.BLOCK, reason: 'recursive delete' },
};

describe('LocalGate — argument rules', () => {
  it('blocks on the call arguments, which never leave this process', () => {
    const verdict = gate([blockRecursiveDelete]).evaluate({
      action: 'mcp.run_shell',
      arguments: { command: 'rm -rf /srv' },
    });

    expect(verdict.effect).toBe(DECISION_EFFECT.BLOCK);
    expect(verdict.reason).toContain('recursive delete');
  });

  it('names the rules it matched as signals, and nothing from the payload', () => {
    const verdict = gate([blockRecursiveDelete]).evaluate({
      action: 'mcp.run_shell',
      arguments: { command: 'rm -rf /srv' },
    });

    expect(verdict.signals).toEqual(['policy:no-rm-rf']);
  });

  it('allows a call no rule matches', () => {
    const verdict = gate([blockRecursiveDelete]).evaluate({
      action: 'mcp.run_shell',
      arguments: { command: 'ls' },
    });

    expect(verdict.effect).toBe(DECISION_EFFECT.ALLOW);
  });
});

describe('LocalGate — rules from disk', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memnox-local-gate-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads the same policy file the runtime reads', async () => {
    const file = join(dir, 'memnox.policies.yaml');
    await writeFile(
      file,
      `version: 1
policies:
  - name: no-env-writes
    match:
      actions: ["file.write"]
      arguments:
        file_path: ["*.env"]
    decision:
      effect: block
      reason: credentials file
`,
      'utf8',
    );

    const loaded = await LocalGate.fromFiles([file], { agentName: 'editor-hook' });

    expect(
      loaded.evaluate({
        action: 'file.write',
        arguments: { file_path: 'services/api/.env' },
      }).effect,
    ).toBe(DECISION_EFFECT.BLOCK);
    expect(loaded.rules().map((rule) => rule.name)).toEqual(['no-env-writes']);
  });
});
