import {
  ALWAYS_TAINTED_SOURCE_TYPES,
  GITHUB_ACTOR_SENSITIVE_SOURCE_TYPES,
  NEVER_TAINTED_SOURCE_TYPES,
  SLACK_SOURCE_TYPE,
  TAINT_MAX_SOURCE_REFS,
  TAINT_META_AUTHOR_ASSOCIATION,
  TAINT_META_AUTHOR_IS_MEMBER,
  TAINT_META_SOURCE_TYPE,
  TAINT_META_TAINTED,
  TRUSTED_GITHUB_AUTHOR_ASSOCIATIONS,
  UNKNOWN_SOURCE_TYPE,
} from '../constants/taint.constants';
import {
  AUTHORITY_TRUSTED_THRESHOLD,
  authorityOf,
} from '../constants/source-authority.constants';

/** LLM enrichment cannot launder taint — derivatives inherit their base classification. */
const ENRICHED_SUFFIX = /_enriched$/;

export interface TaintSourceRef {
  sourceType: string;
  /** Permalink or ID of the untrusted content. */
  reference?: string;
  reason: string;
}

/**
 * Whether untrusted content influenced an agent's context. Threaded as an
 * immutable value with the request — never ambient state — and merged
 * monotonically: once tainted, a session stays tainted.
 */
export interface TaintAssessment {
  tainted: boolean;
  sources: TaintSourceRef[];
}

export const CLEAN_TAINT: TaintAssessment = { tainted: false, sources: [] };

export function mergeTaint(a: TaintAssessment, b: TaintAssessment): TaintAssessment {
  if (!a.tainted && !b.tainted) return CLEAN_TAINT;
  const seen = new Set<string>();
  const sources: TaintSourceRef[] = [];
  for (const source of [...a.sources, ...b.sources]) {
    const key = `${source.sourceType}|${source.reference ?? ''}`;
    if (seen.has(key) || sources.length >= TAINT_MAX_SOURCE_REFS) continue;
    seen.add(key);
    sources.push(source);
  }
  return { tainted: true, sources };
}

export interface TaintClassification {
  tainted: boolean;
  reason?: string;
}

/** Actor facts resolved by the ingestion path; the classifier stays pure. */
export interface TaintSourceFacts {
  /** GitHub author_association as forwarded by the webhook. */
  authorAssociation?: string;
  /** True when the Slack author maps to a known workspace member. */
  authorIsWorkspaceMember?: boolean;
}

const CLEAN_CLASSIFICATION: TaintClassification = { tainted: false };

/** Pure ingestion-time classification: is content from this source, by this author, untrusted? */
export function classifySourceTaint(
  sourceType: string,
  facts: TaintSourceFacts = {},
): TaintClassification {
  const base = sourceType.replace(ENRICHED_SUFFIX, '');

  if (NEVER_TAINTED_SOURCE_TYPES.includes(base)) return CLEAN_CLASSIFICATION;

  if (ALWAYS_TAINTED_SOURCE_TYPES.includes(base)) {
    return { tainted: true, reason: `third-party-authored source "${base}"` };
  }

  if (GITHUB_ACTOR_SENSITIVE_SOURCE_TYPES.includes(base)) {
    const association = facts.authorAssociation;
    if (association !== undefined) {
      return TRUSTED_GITHUB_AUTHOR_ASSOCIATIONS.includes(association)
        ? CLEAN_CLASSIFICATION
        : {
            tainted: true,
            reason: `"${base}" authored by ${association} — outside the repository team`,
          };
    }
    // No association (history sync, pre-taint records) falls through to authority.
  }

  if (base === SLACK_SOURCE_TYPE) {
    if (facts.authorIsWorkspaceMember === true) return CLEAN_CLASSIFICATION;
    return {
      tainted: true,
      reason: `"${base}" from a bot, guest, or unmapped author`,
    };
  }

  const authority = authorityOf(base);
  if (authority < AUTHORITY_TRUSTED_THRESHOLD) {
    return {
      tainted: true,
      reason: `source "${base}" authority ${authority} below trust threshold`,
    };
  }
  return CLEAN_CLASSIFICATION;
}

export interface TaintCheckableRecord {
  sourceType?: string;
  /** Persisted verdict; absent on records ingested before taint tracking shipped. */
  tainted?: boolean;
  metadata?: Record<string, unknown>;
}

/** Records without a persisted flag are re-classified rather than assumed clean. */
export function isRecordTainted(record: TaintCheckableRecord): boolean {
  if (typeof record.tainted === 'boolean') return record.tainted;
  const metadata = record.metadata ?? {};
  const persisted = metadata[TAINT_META_TAINTED];
  if (typeof persisted === 'boolean') return persisted;
  const sourceType =
    record.sourceType ??
    readString(metadata, TAINT_META_SOURCE_TYPE) ??
    UNKNOWN_SOURCE_TYPE;
  return classifySourceTaint(sourceType, factsFrom(metadata)).tainted;
}

/** Rejects anything that is not a well-formed assessment — a partial parse must not clear taint. */
export function parseTaintAssessment(raw: string): TaintAssessment | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // Corrupt payload; the caller decides the fail-closed treatment.
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['tainted'] !== 'boolean') return null;
  if (!Array.isArray(candidate['sources'])) return null;
  const sources: TaintSourceRef[] = [];
  for (const entry of candidate['sources']) {
    if (typeof entry !== 'object' || entry === null) return null;
    const source = entry as Record<string, unknown>;
    const sourceType = source['sourceType'];
    const reason = source['reason'];
    const reference = source['reference'];
    if (typeof sourceType !== 'string' || typeof reason !== 'string') return null;
    sources.push({
      sourceType,
      reason,
      ...(typeof reference === 'string' ? { reference } : {}),
    });
  }
  return { tainted: candidate['tainted'], sources };
}

function factsFrom(metadata: Record<string, unknown>): TaintSourceFacts {
  const association = readString(metadata, TAINT_META_AUTHOR_ASSOCIATION);
  const isMember = metadata[TAINT_META_AUTHOR_IS_MEMBER];
  return {
    ...(association !== undefined ? { authorAssociation: association } : {}),
    ...(typeof isMember === 'boolean' ? { authorIsWorkspaceMember: isMember } : {}),
  };
}

function readString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' ? value : undefined;
}
