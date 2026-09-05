import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadPoliciesFromFile,
  parsePolicySource,
  POLICY_FILE_EXTENSION,
  writePolicyDocumentFile,
} from '../src/gate/policy-file';

const TOML = `
version = 1

[[policies]]
name = "no-force-push"
description = "A force push loses somebody's work."

[policies.match]
actions = ["git.push"]
targets = ["*main*"]

[policies.decision]
effect = "deny"
reason = "main is shared."

[policies.decision.alternative]
action = "git.push"
resource = "a branch"
note = "Open a PR."
`;

const YAML = `
version: 1
policies:
  - name: no-force-push
    match:
      actions: ["git.push"]
    decision:
      effect: deny
      reason: main is shared.
      alternative:
        action: git.push
        note: Open a PR.
`;

const dir = (): Promise<string> => mkdtemp(join(tmpdir(), 'memnox-toml-'));

describe('the policy file format', () => {
  it('is TOML for anything new, which is what the plan specifies', () => {
    expect(POLICY_FILE_EXTENSION).toBe('.toml');
  });

  it('reads a TOML rule file', async () => {
    const path = join(await dir(), 'memnox.policies.toml');
    await writeFile(path, TOML);

    const [policy] = await loadPoliciesFromFile(path);
    expect(policy?.name).toBe('no-force-push');
    expect(policy?.match.actions).toEqual(['git.push']);
    expect(policy?.decision.effect).toBe('deny');
    expect(policy?.decision.alternative?.resource).toBe('a branch');
  });

  it('still reads a YAML file somebody already has', async () => {
    const path = join(await dir(), 'memnox.policies.yaml');
    await writeFile(path, YAML);

    const [policy] = await loadPoliciesFromFile(path);
    expect(policy?.name).toBe('no-force-push');
    expect(policy?.decision.effect).toBe('deny');
  });

  it('produces the same shape from either format', () => {
    const fromToml = parsePolicySource(TOML, 'x.toml') as Record<string, unknown>;
    const fromYaml = parsePolicySource(YAML, 'x.yaml') as Record<string, unknown>;
    expect(Object.keys(fromToml).sort()).toEqual(Object.keys(fromYaml).sort());
  });

  it('writes TOML back when the file is TOML, and never changes somebody’s format', async () => {
    const root = await dir();
    const tomlPath = join(root, 'a.toml');
    const yamlPath = join(root, 'b.yaml');
    const document = {
      version: 1,
      policies: [
        {
          name: 'x',
          match: { actions: ['git.push'] },
          decision: { effect: 'deny', reason: 'r' },
        },
      ],
    } as never;

    await writePolicyDocumentFile(tomlPath, document);
    await writePolicyDocumentFile(yamlPath, document);

    expect(await readFile(tomlPath, 'utf8')).toContain('[[policies]]');
    expect(await readFile(yamlPath, 'utf8')).toContain('policies:');
  });

  it('round-trips a written TOML file back through the loader', async () => {
    const path = join(await dir(), 'r.toml');
    await writePolicyDocumentFile(path, {
      version: 1,
      policies: [
        {
          name: 'round',
          match: { actions: ['deploy.service'] },
          decision: { effect: 'ask', reason: 'a person decides' },
        },
      ],
    } as never);

    const [policy] = await loadPoliciesFromFile(path);
    expect(policy?.name).toBe('round');
    expect(policy?.decision.effect).toBe('ask');
  });

  it('says where to get a rule file when there is none', async () => {
    await expect(loadPoliciesFromFile(join(await dir(), 'missing.toml'))).rejects.toThrow(
      /memnox protect --apply/,
    );
  });
});
