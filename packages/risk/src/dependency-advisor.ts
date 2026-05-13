import type {
  ActionAdvisor,
  ActionRequest,
  Advisory,
  AdvisoryContext,
} from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';
import {
  isVulnerableVersion,
  PACKAGE_ADVISORIES,
  SHIELD_SEVERITY,
} from '@memnox/content-shield';
import {
  BLOCKED_LICENSES,
  DEPENDENCY_ACTIONS,
  DEPENDENCY_SIGNAL,
  REVIEW_LICENSES,
} from './dependency.constants';
import type { LicenseResolver } from './license-resolver';

export const DEPENDENCY_ADVISOR = 'dependency-guard';

const VERSION_SEPARATOR = '@';
const SCOPE_PREFIX = '@';

export interface ParsedPackage {
  name: string;
  version: string | null;
}

/** "left-pad@1.0.0" and "@scope/pkg@1.0.0" both split on the last "@". */
export function parsePackageTarget(target: string): ParsedPackage {
  const separatorIndex = target.lastIndexOf(VERSION_SEPARATOR);
  const isScopeMarker = separatorIndex === 0 && target.startsWith(SCOPE_PREFIX);
  if (separatorIndex <= 0 || isScopeMarker) return { name: target, version: null };
  return {
    name: target.slice(0, separatorIndex),
    version: target.slice(separatorIndex + 1) || null,
  };
}

function licenseMatches(license: string, candidates: readonly string[]): boolean {
  const normalized = license.toUpperCase();
  return candidates.some((candidate) => normalized.includes(candidate.toUpperCase()));
}

/**
 * Governs what third-party code an agent may pull in: known-vulnerable versions
 * and licenses the organization cannot accept.
 *
 * The vulnerability check is offline and always runs. The license check goes
 * through a resolver port — the default is a static table, and a registry-backed
 * resolver is opt-in. An unknown license raises nothing, so a lookup failure can
 * only ever mean "no escalation", never a wrongful block.
 */
export class DependencyAdvisor implements ActionAdvisor {
  readonly name = DEPENDENCY_ADVISOR;

  constructor(
    private readonly licenses: LicenseResolver,
    private readonly approvers: readonly string[],
  ) {}

  async advise(request: ActionRequest, _context: AdvisoryContext): Promise<Advisory[]> {
    if (!DEPENDENCY_ACTIONS.includes(request.action) || !request.target) return [];

    const parsed = parsePackageTarget(request.target);
    const advisories: Advisory[] = [];

    const vulnerability = this.checkVulnerability(parsed);
    if (vulnerability) advisories.push(vulnerability);

    const license = await this.checkLicense(parsed);
    if (license) advisories.push(license);

    return advisories;
  }

  /** Reuses the shield's curated advisory table — one vulnerability list, not two. */
  private checkVulnerability(parsed: ParsedPackage): Advisory | null {
    const advisory = PACKAGE_ADVISORIES.find((entry) => entry.name === parsed.name);
    if (!advisory) return null;
    // No version pinned means any version could be installed, including a bad one.
    if (parsed.version && !isVulnerableVersion(parsed.version, advisory.bad)) return null;

    const critical = advisory.severity === SHIELD_SEVERITY.CRITICAL;
    return {
      source: this.name,
      escalateTo: critical ? DECISION_EFFECT.BLOCK : DECISION_EFFECT.REQUIRE_APPROVAL,
      reason: `${parsed.name}${parsed.version ? `@${parsed.version}` : ''}: ${advisory.reason}`,
      ...(critical ? {} : { approvers: [...this.approvers] }),
      signals: [DEPENDENCY_SIGNAL.KNOWN_VULNERABILITY],
    };
  }

  private async checkLicense(parsed: ParsedPackage): Promise<Advisory | null> {
    const license = await this.licenses.resolve(parsed.name).catch(() => null);
    if (!license) return null;

    if (licenseMatches(license, BLOCKED_LICENSES)) {
      return {
        source: this.name,
        escalateTo: DECISION_EFFECT.BLOCK,
        reason: `${parsed.name} is ${license} — a license this organization does not accept`,
        signals: [DEPENDENCY_SIGNAL.BLOCKED_LICENSE],
      };
    }

    if (licenseMatches(license, REVIEW_LICENSES)) {
      return {
        source: this.name,
        escalateTo: DECISION_EFFECT.REQUIRE_APPROVAL,
        reason: `${parsed.name} is ${license} — needs a legal review before it ships`,
        approvers: [...this.approvers],
        signals: [DEPENDENCY_SIGNAL.REVIEW_LICENSE],
      };
    }

    return null;
  }
}
