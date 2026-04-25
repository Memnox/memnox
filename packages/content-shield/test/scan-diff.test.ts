import { describe, expect, it } from 'vitest';
import { scanDiff } from '../src/scanner';
import { SHIELD_RULESET_VERSION } from '../src/shield-rules';

// Assembled at runtime so no credential-shaped literals exist in this file.
const AWS_KEY = ['AKIA', 'IOSFODNN7', 'BENCHXX'].join('');

function diffFor(file: string, hunkStart: number, lines: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${hunkStart},0 +${hunkStart},${lines.length} @@`,
    ...lines,
    '',
  ].join('\n');
}

describe('scanDiff', () => {
  it('flags a secret on an added line with its real file line number', () => {
    const diff = diffFor('src/deploy.ts', 40, [
      '+const region = "us-east-1";',
      `+const key = "${AWS_KEY}";`,
    ]);
    const result = scanDiff(diff);
    expect(result.blocked).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.file).toBe('src/deploy.ts');
    expect(result.findings[0]?.line).toBe(41);
    expect(result.findings[0]?.excerpt).not.toContain('BENCHXX'); // redacted
    expect(result.rulesetVersion).toBe(SHIELD_RULESET_VERSION);
  });

  it('ignores removed and context lines — pre-existing debt never fails the build', () => {
    const diff = [
      'diff --git a/src/old.ts b/src/old.ts',
      '--- a/src/old.ts',
      '+++ b/src/old.ts',
      '@@ -1,2 +1,1 @@',
      ` const key = "${AWS_KEY}";`,
      `-const gone = "${AWS_KEY}";`,
      '+const clean = "value";',
      '',
    ].join('\n');
    const result = scanDiff(diff);
    expect(result.findings).toHaveLength(0);
    expect(result.blocked).toBe(false);
  });

  it('skips fixture paths like the write-time shield does', () => {
    const diff = diffFor('test/fixtures/keys.ts', 1, [`+const key = "${AWS_KEY}";`]);
    expect(scanDiff(diff).findings).toHaveLength(0);
  });

  it('ignores additions to deleted files and handles empty diffs', () => {
    const deleted = [
      'diff --git a/src/gone.ts b/src/gone.ts',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      `-const key = "${AWS_KEY}";`,
      '',
    ].join('\n');
    expect(scanDiff(deleted).findings).toHaveLength(0);
    expect(scanDiff('').findings).toHaveLength(0);
    expect(scanDiff('').scannedFiles).toBe(0);
  });

  it('maps line numbers correctly across multiple hunks and files', () => {
    const diff = [
      'diff --git a/src/config.ts b/src/config.ts',
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '@@ -1,0 +1,1 @@',
      '+const first = "safe";',
      '@@ -10,2 +90,3 @@',
      ' const context = 1;',
      '+const second = "safe";',
      `+const key = "${AWS_KEY}";`,
      'diff --git a/package.json b/package.json',
      '--- a/package.json',
      '+++ b/package.json',
      '@@ -12,0 +12,1 @@',
      '+    "lodash": "^4.17.15",',
      '',
    ].join('\n');
    const result = scanDiff(diff);
    expect(result.scannedFiles).toBe(2);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]?.line).toBe(92);
    expect(result.findings[1]?.file).toBe('package.json');
    expect(result.findings[1]?.rule).toBe('vulnerable-package/lodash');
    expect(result.findings[1]?.line).toBe(12);
  });
});
