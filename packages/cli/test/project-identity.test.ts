import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY_FILE } from '../src/defaults';
import { findPolicyFile, resolveProjectId } from '../src/project-identity';

const policyFile = (project?: string): string =>
  `${project === undefined ? '' : `project: ${project}\n`}version: 1\npolicies: []\n`;

describe('project identity', () => {
  let root: string;

  const repo = async (name: string, project?: string): Promise<string> => {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, DEFAULT_POLICY_FILE), policyFile(project), 'utf8');
    return dir;
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'memnox-project-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('resolves two separate repos that declare one project to the same scope', async () => {
    const web = await repo('web', 'acme-checkout');
    const api = await repo('api', 'acme-checkout');

    expect(resolveProjectId(web)).toBe('acme-checkout');
    expect(resolveProjectId(api)).toBe('acme-checkout');
  });

  it('keeps unrelated repos in separate scopes', async () => {
    const web = await repo('web', 'acme-checkout');
    const other = await repo('other', 'billing-service');

    expect(resolveProjectId(web)).not.toBe(resolveProjectId(other));
  });

  it('resolves from a nested directory, not just the repo root', async () => {
    const api = await repo('api', 'acme-checkout');
    const nested = join(api, 'src', 'payment', 'handlers');
    await mkdir(nested, { recursive: true });

    expect(resolveProjectId(nested)).toBe('acme-checkout');
  });

  it('stops at the nearest policy file when repos are nested', async () => {
    const outer = await repo('outer', 'outer-project');
    const inner = join(outer, 'packages', 'inner');
    await mkdir(inner, { recursive: true });
    await writeFile(
      join(inner, DEFAULT_POLICY_FILE),
      policyFile('inner-project'),
      'utf8',
    );

    expect(resolveProjectId(inner)).toBe('inner-project');
  });

  it('returns nothing when the policy file declares no project', async () => {
    const web = await repo('web');

    expect(resolveProjectId(web)).toBeUndefined();
  });

  it('returns nothing when there is no policy file at all', async () => {
    const bare = join(root, 'bare');
    await mkdir(bare, { recursive: true });

    expect(resolveProjectId(bare)).toBeUndefined();
  });

  it('treats malformed YAML as no project rather than throwing at the hook', async () => {
    const broken = join(root, 'broken');
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, DEFAULT_POLICY_FILE), 'project: [unclosed\n', 'utf8');

    expect(() => resolveProjectId(broken)).not.toThrow();
    expect(resolveProjectId(broken)).toBeUndefined();
  });

  it('ignores a blank project rather than scoping everything to an empty name', async () => {
    const blank = join(root, 'blank');
    await mkdir(blank, { recursive: true });
    await writeFile(
      join(blank, DEFAULT_POLICY_FILE),
      'project: "   "\nversion: 1\n',
      'utf8',
    );

    expect(resolveProjectId(blank)).toBeUndefined();
  });

  it('trims a declared project so whitespace cannot split one scope in two', async () => {
    const padded = join(root, 'padded');
    await mkdir(padded, { recursive: true });
    await writeFile(
      join(padded, DEFAULT_POLICY_FILE),
      'project: "  acme-checkout  "\nversion: 1\n',
      'utf8',
    );

    expect(resolveProjectId(padded)).toBe('acme-checkout');
  });

  it('resolves nothing for an undefined working directory', () => {
    expect(resolveProjectId(undefined)).toBeUndefined();
  });

  it('finds the policy file it resolved from', async () => {
    const api = await repo('api', 'acme-checkout');

    expect(findPolicyFile(api)).toBe(join(api, DEFAULT_POLICY_FILE));
  });
});
