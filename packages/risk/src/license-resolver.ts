import { LICENSE_LOOKUP_TIMEOUT_MS, NPM_REGISTRY_URL } from './dependency.constants';

/**
 * Resolves a package's SPDX license. Kept behind a port so the decision path can
 * stay offline by default: the static resolver is deterministic, and the registry
 * resolver is an explicit opt-in that trades determinism for coverage.
 */
export interface LicenseResolver {
  /** null means "unknown" — never guess, an unknown license raises nothing. */
  resolve(packageName: string): Promise<string | null>;
}

/** Offline resolver over a caller-supplied table. The zero-infrastructure default. */
export class StaticLicenseResolver implements LicenseResolver {
  private readonly licenses: Map<string, string>;

  constructor(licenses: Readonly<Record<string, string>> = {}) {
    this.licenses = new Map(Object.entries(licenses));
  }

  async resolve(packageName: string): Promise<string | null> {
    return this.licenses.get(packageName) ?? null;
  }
}

/**
 * Reads the license from the npm registry. Every failure — offline, timeout,
 * 404, malformed body — resolves to null, which the advisor treats as "unknown"
 * and therefore as no escalation.
 */
export class NpmRegistryLicenseResolver implements LicenseResolver {
  constructor(
    private readonly registryUrl: string = NPM_REGISTRY_URL,
    private readonly timeoutMs: number = LICENSE_LOOKUP_TIMEOUT_MS,
  ) {}

  async resolve(packageName: string): Promise<string | null> {
    try {
      const response = await fetch(
        `${this.registryUrl}/${encodeURIComponent(packageName)}/latest`,
        { signal: AbortSignal.timeout(this.timeoutMs) },
      );
      if (!response.ok) return null;
      const body = (await response.json()) as { license?: unknown };
      return typeof body.license === 'string' ? body.license : null;
    } catch {
      // Unreachable registry is indistinguishable from an unknown license, and both mean "no signal".
      return null;
    }
  }
}
