import { createHash } from 'node:crypto';
import { canonicalJson } from '../domain/canonical-json';
import type { Policy } from './policy';

/**
 * A short content hash of the whole rule set, stamped on every event so `why` can answer
 * about a decision taken before the rules were edited, and two machines agree unasked.
 */
const HASH_ALGORITHM = 'sha256';
const HASH_ENCODING = 'hex';
/** Enough to be unambiguous in a log line without pasting 64 characters. */
export const POLICY_VERSION_LENGTH = 12;

export interface PolicySetVersion {
  /** Short content hash, which is the identity of this exact rule set. */
  version: string;
  policyCount: number;
  /** Policy names, sorted, so a reviewer can see the shape at a glance. */
  policyNames: string[];
}

/** Content-addressed, so an audit event can name the rules that produced it. */
export function versionPolicySet(policies: readonly Policy[]): PolicySetVersion {
  const sorted = [...policies].sort((left, right) => left.name.localeCompare(right.name));
  const digest = createHash(HASH_ALGORITHM)
    .update(canonicalJson(sorted))
    .digest(HASH_ENCODING);
  return {
    version: digest.slice(0, POLICY_VERSION_LENGTH),
    policyCount: policies.length,
    policyNames: sorted.map((policy) => policy.name),
  };
}
