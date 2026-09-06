import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadLocalGate } from '../src/local-gate-loader';

const RULES = `version = 1

[[policies]]
name = "no-deletion"
match = { actions = ["mcp.delete_customer"] }
decision = { effect = "deny", reason = "not ours to delete" }
`;

async function machine(): Promise<{ home: string; rules: string }> {
  const home = await mkdtemp(join(tmpdir(), 'memnox-gate-'));
  const rules = join(home, 'memnox.policies.toml');
  await writeFile(rules, RULES, 'utf8');
  await mkdir(join(home, '.memnox'), { recursive: true });
  await writeFile(
    join(home, '.memnox', 'policies.json'),
    JSON.stringify({ files: [rules] }),
    'utf8',
  );
  return { home, rules };
}

describe('where the proxy finds its rules', () => {
  /* `mcp wrap` repoints every server at the proxy, and an editor started from a dock
     icon carries no environment. Reading only the environment meant the proxy came up
     with no rules and forwarded everything it was installed to stop. */
  it('falls back to the registry when no environment variable is set', async () => {
    const { home } = await machine();

    const gate = await loadLocalGate({}, 'github', home);

    expect(gate).not.toBeNull();
    expect(gate?.evaluate({ action: 'mcp.delete_customer' }).effect).toBe('deny');
  });

  it('prefers the environment when it names files, so a run can override', async () => {
    const { home, rules } = await machine();

    const gate = await loadLocalGate({ policies: rules }, 'github', home);

    expect(gate?.evaluate({ action: 'mcp.delete_customer' }).effect).toBe('deny');
  });

  it('is null when neither names a file, so the tool filters are the only gate', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-gate-'));

    expect(await loadLocalGate({}, 'github', home)).toBeNull();
  });

  it('names the server when no agent name was handed in, so a row is attributable', async () => {
    const { home } = await machine();

    const gate = await loadLocalGate({}, 'github', home);
    expect(gate?.evaluate({ action: 'mcp.delete_customer' }).reason).toContain(
      'not ours to delete',
    );
  });
});
