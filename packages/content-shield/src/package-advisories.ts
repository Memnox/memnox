import { truncate, type ShieldFinding } from './finding';
import { SHIELD_SEVERITY, type ShieldSeverity } from './shield-rules';

/** Versions below this sentinel are all bad — used for packages with no safe release. */
const ALL_VERSIONS_BELOW = '999.0.0';
/** major.minor.patch — pre-release segments never decide a comparison. */
const VERSION_SEGMENTS = 3;
const VERSION_IN_RANGE = /(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?)/;

export type BadVersions = readonly string[] | { below: string };

export interface PackageAdvisory {
  name: string;
  bad: BadVersions;
  severity: ShieldSeverity;
  reason: string;
}

/**
 * Hand-curated and deliberately small: supply-chain hijacks plus the CVEs
 * agents most often reintroduce by pinning an old version.
 */
export const PACKAGE_ADVISORIES: readonly PackageAdvisory[] = [
  {
    name: 'event-stream',
    bad: ['3.3.6'],
    severity: SHIELD_SEVERITY.CRITICAL,
    reason: 'v3.3.6 shipped the malicious flatmap-stream wallet-stealing dependency',
  },
  {
    name: 'flatmap-stream',
    bad: { below: ALL_VERSIONS_BELOW },
    severity: SHIELD_SEVERITY.CRITICAL,
    reason: 'malicious package — every version, injected via event-stream',
  },
  {
    name: 'ua-parser-js',
    bad: ['0.7.29', '0.8.0', '1.0.0'],
    severity: SHIELD_SEVERITY.CRITICAL,
    reason: 'hijacked versions shipped a cryptominer and credential stealer',
  },
  {
    name: 'node-ipc',
    bad: ['10.1.1', '10.1.2'],
    severity: SHIELD_SEVERITY.CRITICAL,
    reason: 'versions with a destructive protestware payload (CVE-2022-23812)',
  },
  {
    name: 'coa',
    bad: ['2.0.3', '2.0.4', '2.1.1', '2.1.3', '3.0.1', '3.1.3'],
    severity: SHIELD_SEVERITY.CRITICAL,
    reason: 'hijacked versions shipped credential-stealing malware',
  },
  {
    name: 'rc',
    bad: ['1.2.9', '1.3.9', '2.3.9'],
    severity: SHIELD_SEVERITY.CRITICAL,
    reason: 'hijacked versions shipped credential-stealing malware',
  },
  {
    name: 'colors',
    bad: ['1.4.1', '1.4.2'],
    severity: SHIELD_SEVERITY.CRITICAL,
    reason: 'sabotaged versions with an infinite-loop denial of service',
  },
  {
    name: 'faker',
    bad: ['6.6.6'],
    severity: SHIELD_SEVERITY.CRITICAL,
    reason: 'sabotaged version wiping the package contents',
  },
  {
    name: 'lodash',
    bad: { below: '4.17.21' },
    severity: SHIELD_SEVERITY.HIGH,
    reason: 'prototype pollution / command injection (CVE-2020-8203, CVE-2021-23337)',
  },
  {
    name: 'minimist',
    bad: { below: '1.2.6' },
    severity: SHIELD_SEVERITY.HIGH,
    reason: 'prototype pollution (CVE-2021-44906)',
  },
  {
    name: 'xmldom',
    bad: { below: ALL_VERSIONS_BELOW },
    severity: SHIELD_SEVERITY.HIGH,
    reason: 'unmaintained with unfixed parsing vulnerabilities — use @xmldom/xmldom',
  },
  {
    name: 'shelljs',
    bad: { below: '0.8.5' },
    severity: SHIELD_SEVERITY.HIGH,
    reason: 'improper privilege handling (CVE-2022-0144)',
  },
];

interface AdvisoryMatchers {
  advisory: PackageAdvisory;
  /** package.json: "name": "^1.2.3" */
  manifest: RegExp;
  /** lockfiles: name@1.2.3, name@npm:1.2.3, "name@^1.2.3": */
  lock: RegExp;
}

const MATCHERS: readonly AdvisoryMatchers[] = PACKAGE_ADVISORIES.map((advisory) => ({
  advisory,
  manifest: new RegExp(`"${escapeRegExp(advisory.name)}"\\s*:\\s*"([^"]+)"`),
  lock: new RegExp(
    `(?:^|[\\s"/])${escapeRegExp(advisory.name)}@(?:npm:)?[~^><=\\s]*(\\d+\\.\\d+\\.\\d+[^\\s",]*)`,
  ),
}));

/** Scans one manifest or lockfile line against the advisory table. */
export function scanPackageLine(
  file: string,
  text: string,
  line: number,
): ShieldFinding[] {
  const findings: ShieldFinding[] = [];
  for (const { advisory, manifest, lock } of MATCHERS) {
    const fromManifest = manifest.exec(text);
    const fromLock = fromManifest === null ? lock.exec(text) : null;
    const raw =
      fromManifest === null
        ? fromLock === null
          ? undefined
          : fromLock[1]
        : fromManifest[1];
    if (raw === undefined) continue;
    const version = extractVersion(raw);
    if (version === null || !isVulnerableVersion(version, advisory.bad)) continue;
    findings.push({
      rule: `vulnerable-package/${advisory.name}`,
      severity: advisory.severity,
      file,
      line,
      excerpt: truncate(text.trim()),
      message: `${advisory.name}@${version} — ${advisory.reason}`,
      fix: `Use a patched version of ${advisory.name} (or a maintained replacement) and run npm audit.`,
    });
  }
  return findings;
}

/** The lowest concrete version a range can resolve to — `^1.2.3` and `>=1.2.3` both give 1.2.3. */
export function extractVersion(range: string): string | null {
  const match = VERSION_IN_RANGE.exec(range);
  return match === null ? null : (match[1] ?? null);
}

export function isVulnerableVersion(version: string, bad: BadVersions): boolean {
  if ('below' in bad) return compareVersions(version, bad.below) < 0;
  return bad.includes(version);
}

/** Negative when a < b, zero when equal or when a segment is not numeric — never guesses. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(/[-.]/);
  const right = b.split(/[-.]/);
  for (let i = 0; i < VERSION_SEGMENTS; i += 1) {
    const da = Number.parseInt(left[i] ?? '0', 10);
    const db = Number.parseInt(right[i] ?? '0', 10);
    if (Number.isNaN(da) || Number.isNaN(db)) return 0;
    if (da !== db) return da - db;
  }
  return 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
