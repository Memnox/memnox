import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadPolicyFiles,
  readPolicyDocumentFile,
  readPolicyRegistry,
  writePolicyDocumentFile,
} from '../src/policy-file';

const doc = (project: string | undefined, name: string, effect: string): string =>
  `${project === undefined ? '' : `project: ${project}\n`}version: 1
policies:
  - name: ${name}
    match: { actions: ["file.write"] }
    decision: { effect: ${effect}, reason: ${name} }
`;

describe('policy sources', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memnox-sources-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('tags every rule with the project its file declared', async () => {
    const file = join(dir, 'web.yaml');
    await writeFile(file, doc('acme', 'web-rule', 'allow'), 'utf8');

    const [policy] = await loadPolicyFiles([file]);

    expect(policy?.project).toBe('acme');
  });

  it('leaves rules unscoped when the file declares no project', async () => {
    const file = join(dir, 'base.yaml');
    await writeFile(file, doc(undefined, 'baseline', 'allow'), 'utf8');

    const [policy] = await loadPolicyFiles([file]);

    expect(policy?.project).toBeUndefined();
  });

  it('composes the rule files of every repository in a project', async () => {
    const web = join(dir, 'web.yaml');
    const api = join(dir, 'api.yaml');
    await writeFile(web, doc('acme', 'web-rule', 'allow'), 'utf8');
    await writeFile(api, doc('acme', 'api-rule', 'withhold'), 'utf8');

    const policies = await loadPolicyFiles([web, api]);

    expect(policies.map((policy) => policy.name)).toEqual(['web-rule', 'api-rule']);
  });

  it('skips a registered file that has since been deleted, and says which', async () => {
    // One repo losing its policy file used to stop every other project on the
    // machine from starting a runtime at all.
    const mine = join(dir, 'mine.yaml');
    const theirs = join(dir, 'deleted-repo.yaml');
    await writeFile(mine, doc('acme', 'my-rule', 'allow'), 'utf8');
    const skipped: string[] = [];

    const policies = await loadPolicyFiles([mine, theirs], {
      optional: new Set([theirs]),
      onSkipped: (file) => skipped.push(file),
    });

    expect(policies.map((policy) => policy.name)).toEqual(['my-rule']);
    expect(skipped).toEqual([theirs]);
  });

  it('still fails on a file this run named itself — a typo has to be loud', async () => {
    const missing = join(dir, 'typo.yaml');

    await expect(
      loadPolicyFiles([missing], { optional: new Set(), onSkipped: () => {} }),
    ).rejects.toThrow(/No policy file at/);
  });

  it('never skips a malformed registered file — that is a real fault', async () => {
    const broken = join(dir, 'broken.yaml');
    await writeFile(broken, 'version: 1\npolicies: [{ name: x }]\n', 'utf8');

    await expect(
      loadPolicyFiles([broken], { optional: new Set([broken]) }),
    ).rejects.toThrow();
  });

  it('treats a missing registry as no extra sources, not an error', async () => {
    expect(await readPolicyRegistry(join(dir, 'absent.json'))).toEqual([]);
  });

  it('reads the file list a joining repository registered', async () => {
    const registry = join(dir, 'policies.json');
    await writeFile(registry, JSON.stringify({ files: ['/a.yaml', '/b.yaml'] }), 'utf8');

    expect(await readPolicyRegistry(registry)).toEqual(['/a.yaml', '/b.yaml']);
  });

  it('reads the document without folding the project into every rule', async () => {
    const file = join(dir, 'scoped.yaml');
    await writeFile(file, doc('acme', 'web-rule', 'allow'), 'utf8');

    const document = await readPolicyDocumentFile(file);

    expect(document?.project).toBe('acme');
    expect(document?.policies[0]?.project).toBeUndefined();
  });

  it('reports a file that does not exist yet rather than throwing', async () => {
    expect(await readPolicyDocumentFile(join(dir, 'absent.yaml'))).toBeNull();
  });

  it('round-trips the project declaration through a write', async () => {
    const file = join(dir, 'scoped.yaml');
    await writeFile(file, doc('acme', 'web-rule', 'allow'), 'utf8');

    const document = await readPolicyDocumentFile(file);
    if (document === null) throw new Error('expected a document');
    await writePolicyDocumentFile(file, document);

    expect(await readFile(file, 'utf8')).toContain('project: acme');
    expect((await readPolicyDocumentFile(file))?.project).toBe('acme');
  });
});
