import { createHash } from 'node:crypto';
import type { AgentRef } from './agent';
import {
  FINGERPRINT_ALGORITHM,
  FINGERPRINT_LENGTH,
  RESOURCE_KIND,
  SENSITIVITY,
  type ResourceKind,
  type Sensitivity,
} from './discovery.constants';

export interface Resource {
  id: string;
  kind: ResourceKind;
  path?: string;
  /** A hash. NEVER the value: what is stored is a path, a kind and this. */
  fingerprint?: string;
  sensitivity: Sensitivity;
  reachableBy: AgentRef[];
}

/**
 * The value stays in the process that read it. A shareable report carrying the shape of
 * somebody's SSH key would be the single worst bug this product could ship, so the
 * fingerprint is truncated: enough to tell two files apart, not enough to attack one.
 */
export function fingerprint(value: string): string {
  return createHash(FINGERPRINT_ALGORITHM)
    .update(value)
    .digest('hex')
    .slice(0, FINGERPRINT_LENGTH);
}

/** Paths whose contents are credentials by construction, not by guess. */
const CRITICAL_PATTERNS = [
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)\.ssh\/id_[a-z0-9_]+$/,
  /(^|\/)\.kube\/config$/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.pypirc$/,
];

const SENSITIVE_PATTERNS = [
  /(^|\/)\.env(\.[a-z0-9_-]+)?$/,
  /(^|\/)\.netrc$/,
  /(^|\/)secrets?\.(ya?ml|json)$/,
  /(^|\/)service-account.*\.json$/,
];

export function classifySensitivity(path: string): Sensitivity {
  if (CRITICAL_PATTERNS.some((pattern) => pattern.test(path)))
    return SENSITIVITY.CRITICAL;
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(path)))
    return SENSITIVITY.SENSITIVE;
  return SENSITIVITY.ORDINARY;
}

export function isCredentialPath(path: string): boolean {
  return classifySensitivity(path) !== SENSITIVITY.ORDINARY;
}

/** The kind is read off the path, so nothing has to open a file to be counted. */
export function classifyResourceKind(path: string): ResourceKind {
  if (path.endsWith('.sock')) return RESOURCE_KIND.SOCKET;
  if (isCredentialPath(path)) return RESOURCE_KIND.SECRET;
  if (path.endsWith('/.git') || path.includes('/.git/')) return RESOURCE_KIND.REPO;
  return RESOURCE_KIND.FILE;
}
