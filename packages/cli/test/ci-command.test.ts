import { afterEach, describe, expect, it } from 'vitest';
import { registerCiCommand } from '../src/commands/ci.command';
import type { DiffSelection } from '../src/git-diff';
import { runCommand } from './cli-harness';

// Assembled at runtime so no credential-shaped literal exists in this file.
const AWS_KEY = ['AKIA', 'IOSFODNN7', 'CITESTX'].join('');

const diffWith = (file: string, ...added: string[]): string =>
  [`+++ b/${file}`, '@@ -0,0 +1,1 @@', ...added.map((line) => `+${line}`)].join('\n');

const SECRET_DIFF = diffWith('src/config.ts', `const key = "${AWS_KEY}";`);
const CLEAN_DIFF = diffWith('src/config.ts', 'const region = "us-east-1";');

async function runCi(
  args: string[],
  diff: string,
  onSelect?: (selection: DiffSelection) => void,
): ReturnType<typeof runCommand> {
  return runCommand(
    (program, context) =>
      registerCiCommand(program, context, (selection) => {
        if (onSelect !== undefined) onSelect(selection);
        return { diff, base: 'HEAD~1' };
      }),
    ['ci', ...args],
  );
}

afterEach(() => {
  process.exitCode = undefined;
});

describe('memnox ci', () => {
  it('reports a clean diff and leaves the exit code alone', async () => {
    const { out } = await runCi([], CLEAN_DIFF);

    expect(out.text).toContain('memnox ci: CLEAN');
    expect(out.text).toContain('1 changed file(s)');
    expect(process.exitCode).toBeUndefined();
  });

  it('names the file, line, rule, and fix for a finding', async () => {
    const { out } = await runCi([], SECRET_DIFF);

    expect(out.text).toContain('src/config.ts:1');
    expect(out.text).toContain('aws-access-key');
    expect(out.text).toContain('fix:');
  });

  it('never echoes the matched secret back', async () => {
    const { out } = await runCi([], SECRET_DIFF);

    expect(out.text).not.toContain(AWS_KEY);
  });

  it('exits 1 on a blocking finding', async () => {
    const { out } = await runCi([], SECRET_DIFF);

    expect(out.text).toContain('BLOCKED — 1 blocking finding(s)');
    expect(process.exitCode).toBe(1);
  });

  it('reports but does not fail when --no-fail is passed', async () => {
    const { out } = await runCi(['--no-fail'], SECRET_DIFF);

    expect(out.text).toContain('BLOCKED');
    expect(process.exitCode).toBeUndefined();
  });

  it('emits parseable JSON with --json instead of the human report', async () => {
    const { out } = await runCi(['--json'], SECRET_DIFF);

    const report = JSON.parse(out.text) as {
      blocked: boolean;
      findings: Array<{ rule: string }>;
    };
    expect(report.blocked).toBe(true);
    expect(report.findings[0]?.rule).toBe('aws-access-key');
    expect(out.text).not.toContain('memnox ci:');
  });

  it('asks for staged changes when --staged is passed', async () => {
    let selection: DiffSelection | undefined;
    await runCi(['--staged'], CLEAN_DIFF, (s) => (selection = s));

    expect(selection?.staged).toBe(true);
  });

  it('passes --base through as the diff ref', async () => {
    let selection: DiffSelection | undefined;
    await runCi(['--base', 'origin/main'], CLEAN_DIFF, (s) => (selection = s));

    expect(selection?.base).toBe('origin/main');
    expect(selection?.staged).toBeUndefined();
  });

  it('does not scan a path the shield skips', async () => {
    const { out } = await runCi(
      [],
      diffWith('test/fixtures/keys.ts', `const key = "${AWS_KEY}";`),
    );

    expect(out.text).toContain('CLEAN');
    expect(process.exitCode).toBeUndefined();
  });
});
