import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import type { Policy } from '@memnox/policy-engine';
import { LocalGate, SECRET_RESPONSE, type SecretResponse } from '../src/index';

/** Secrets are assembled at runtime so no test file ever holds one literally. */
const awsKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
/** A finding the masker cannot fix: the value is named, not quoted. */
const unmaskable = ['logger.info("pass', 'word: " + pass', 'word)'].join('');

const gate = (
  policies: Policy[],
  onSecret: SecretResponse = SECRET_RESPONSE.BLOCK,
): LocalGate => new LocalGate(policies, { agentName: 'mcp:github', onSecret });

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

describe('LocalGate — secrets in arguments', () => {
  it('blocks a call carrying a credential, by default', () => {
    const verdict = gate([]).evaluate({
      action: 'mcp.create_issue',
      arguments: { body: `deploy key is ${awsKey}` },
    });

    expect(verdict.effect).toBe(DECISION_EFFECT.BLOCK);
    expect(verdict.reason).toContain('body');
    expect(verdict.signals).toContain('shield:aws-access-key');
    // The reason names the finding, never the secret itself.
    expect(verdict.reason).not.toContain(awsKey);
  });

  it('masks instead of blocking when configured to redact', () => {
    const verdict = gate([], SECRET_RESPONSE.REDACT).evaluate({
      action: 'mcp.create_issue',
      arguments: { body: `deploy key is ${awsKey}`, title: 'infra' },
    });

    expect(verdict.effect).toBe(DECISION_EFFECT.REDACT);
    expect(verdict.redactedArguments?.body).not.toContain(awsKey);
    expect(verdict.redactedArguments?.title).toBe('infra');
  });

  it('reports and lets through when configured to signal only', () => {
    const verdict = gate([], SECRET_RESPONSE.SIGNAL).evaluate({
      action: 'mcp.create_issue',
      arguments: { body: `deploy key is ${awsKey}` },
    });

    expect(verdict.effect).toBe(DECISION_EFFECT.ALLOW);
    expect(verdict.signals).toContain('shield:aws-access-key');
  });

  it('never loosens a rule: a blocked call stays blocked under redact', () => {
    const verdict = gate([blockRecursiveDelete], SECRET_RESPONSE.REDACT).evaluate({
      action: 'mcp.run_shell',
      arguments: { command: `rm -rf /srv # ${awsKey}` },
    });

    expect(verdict.effect).toBe(DECISION_EFFECT.BLOCK);
  });

  it('blocks when masking leaves a blocking finding behind', () => {
    const verdict = gate([], SECRET_RESPONSE.REDACT).evaluate({
      action: 'mcp.write_file',
      arguments: { content: unmaskable },
    });

    expect(verdict.effect).toBe(DECISION_EFFECT.BLOCK);
    expect(verdict.reason).toContain('cannot be masked safely');
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
