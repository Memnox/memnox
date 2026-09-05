import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { plainStyle } from '../src/style';
import { registerPolicyCommand } from '../src/commands/policy.command';

const RULES = `
version = 1

[[policies]]
name = "git-deny"
[policies.match]
actions = ["git.push"]
[policies.decision]
effect = "deny"
reason = "it rewrites shared history"
[policies.decision.alternative]
action = "git.push"
resource = "a branch"
note = "Open a PR."

[[policies]]
name = "delete-ask"
[policies.match]
actions = ["filesystem.delete"]
[policies.decision]
effect = "ask"
reason = "a person should look"
`;

async function rules(): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'memnox-pt-')), 'p.toml');
  await writeFile(path, RULES);
  return path;
}

async function run(args: string[]): Promise<RecordedOutput> {
  const out = new RecordedOutput();
  const program = new Command();
  registerPolicyCommand(program, new CliContext(out, plainStyle));
  await program.parseAsync(args, { from: 'user' });
  return out;
}

afterEach(() => {
  process.exitCode = 0;
});

describe('memnox policy test', () => {
  it('denies a force push typed the way somebody actually types it', async () => {
    const out = await run(['policy', 'test', 'git push --force', '-f', await rules()]);

    expect(out.text).toContain('DENY');
    expect(out.text).toContain('git-deny');
    expect(out.text).toContain('it rewrites shared history');
    // Exit code is what makes it usable in a git hook.
    expect(process.exitCode).toBe(1);
  });

  it('names the way forward, so the refusal is not a dead end', async () => {
    const out = await run(['policy', 'test', 'git push --force', '-f', await rules()]);
    expect(out.text).toContain('instead git.push a branch');
  });

  it('takes a namespaced action too, the way a git hook calls it', async () => {
    const out = await run(['policy', 'test', 'git.push', '-f', await rules()]);
    expect(out.text).toContain('DENY');
  });

  it('asks about a destructive command rather than denying it', async () => {
    const out = await run(['policy', 'test', 'rm -rf build', '-f', await rules()]);
    expect(out.text).toContain('ASK');
    expect(out.text).toContain('delete-ask');
  });

  it('allows what no rule covers, and exits zero', async () => {
    const out = await run(['policy', 'test', 'ls -la', '-f', await rules()]);
    expect(out.text).toContain('ALLOW');
    expect(process.exitCode).toBe(0);
  });

  it('says where to get rules when there are none', async () => {
    await expect(
      run(['policy', 'test', 'git push', '-f', '/nope/p.toml']),
    ).rejects.toThrow(/memnox protect/);
  });
});
