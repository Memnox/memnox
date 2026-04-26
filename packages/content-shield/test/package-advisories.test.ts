import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  extractVersion,
  isVulnerableVersion,
  PACKAGE_ADVISORIES,
  scanPackageLine,
} from '../src/package-advisories';
import { scanContent } from '../src/scanner';
import { SHIELD_SEVERITY } from '../src/shield-rules';

describe('compareVersions', () => {
  it('orders releases by numeric segment and ignores pre-release noise', () => {
    expect(compareVersions('4.17.20', '4.17.21')).toBeLessThan(0);
    expect(compareVersions('4.17.21', '4.17.21')).toBe(0);
    expect(compareVersions('4.18.0', '4.17.21')).toBeGreaterThan(0);
    expect(compareVersions('10.1.2', '9.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3-beta.1', '1.2.3')).toBe(0);
  });

  it('refuses to guess when a segment is not numeric', () => {
    expect(compareVersions('next', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0', 'latest')).toBe(0);
  });
});

describe('extractVersion', () => {
  it('resolves the lowest concrete version a range can install', () => {
    expect(extractVersion('^4.17.15')).toBe('4.17.15');
    expect(extractVersion('~1.2.5')).toBe('1.2.5');
    expect(extractVersion('>=1.2.6 <2.0.0')).toBe('1.2.6');
    expect(extractVersion('4.17.15')).toBe('4.17.15');
    expect(extractVersion('*')).toBeNull();
  });
});

describe('isVulnerableVersion', () => {
  it('matches exact-version lists and version ceilings', () => {
    expect(isVulnerableVersion('3.3.6', ['3.3.6'])).toBe(true);
    expect(isVulnerableVersion('3.3.5', ['3.3.6'])).toBe(false);
    expect(isVulnerableVersion('4.17.20', { below: '4.17.21' })).toBe(true);
    expect(isVulnerableVersion('4.17.21', { below: '4.17.21' })).toBe(false);
  });
});

describe('scanPackageLine', () => {
  it('flags a vulnerable range in a package.json dependency line', () => {
    const findings = scanPackageLine('package.json', '    "lodash": "^4.17.15",', 12);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('vulnerable-package/lodash');
    expect(findings[0]?.severity).toBe(SHIELD_SEVERITY.HIGH);
    expect(findings[0]?.line).toBe(12);
    expect(findings[0]?.message).toContain('4.17.15');
  });

  it('flags lockfile shapes as well as manifests', () => {
    expect(scanPackageLine('yarn.lock', 'lodash@^4.17.15:', 1)).toHaveLength(1);
    expect(scanPackageLine('yarn.lock', '  "lodash@npm:4.17.15":', 1)).toHaveLength(1);
    expect(
      scanPackageLine('package-lock.json', '    "ua-parser-js": "0.7.29",', 1),
    ).toHaveLength(1);
  });

  it('leaves patched versions alone', () => {
    expect(scanPackageLine('package.json', '    "lodash": "^4.17.21",', 1)).toHaveLength(
      0,
    );
    expect(scanPackageLine('yarn.lock', 'lodash@^4.17.21:', 1)).toHaveLength(0);
    expect(
      scanPackageLine('package.json', '    "event-stream": "^4.0.1",', 1),
    ).toHaveLength(0);
    expect(scanPackageLine('package.json', '    "express": "^4.17.1",', 1)).toHaveLength(
      0,
    );
  });

  it('flags hijacked exact versions and packages with no safe release', () => {
    const hijacked = scanPackageLine('package.json', '"event-stream": "3.3.6"', 1);
    expect(hijacked[0]?.severity).toBe(SHIELD_SEVERITY.CRITICAL);
    expect(scanPackageLine('package.json', '"node-ipc": "10.1.2"', 1)).toHaveLength(1);
    expect(scanPackageLine('package.json', '"flatmap-stream": "0.1.1"', 1)).toHaveLength(
      1,
    );
  });

  it('is reachable through path routing for manifests and lockfiles only', () => {
    expect(scanContent('package.json', '  "minimist": "~1.2.5"')).toHaveLength(1);
    expect(scanContent('pnpm-lock.yaml', '  minimist@1.2.5:')).toHaveLength(1);
    expect(scanContent('src/app.ts', '  "minimist": "~1.2.5"')).toHaveLength(0);
  });

  it('keeps the advisory table curated', () => {
    expect(PACKAGE_ADVISORIES).toHaveLength(12);
    expect(new Set(PACKAGE_ADVISORIES.map((advisory) => advisory.name)).size).toBe(12);
  });
});
