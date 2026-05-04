import { createHash } from 'node:crypto';
import type { DecisionRecord } from './decision-record';

/**
 * Content identity for near-duplicate suppression: the same decision restated
 * in Slack, a meeting, and a PR must converge to one constraint. Normalized
 * over what the decision *does* (statement + patterns), not who recorded it.
 */
export function fingerprintDecision(
  record: Pick<DecisionRecord, 'statement' | 'actions' | 'targets' | 'environments'>,
): string {
  const normalized = [
    normalizeText(record.statement),
    ...normalizePatterns(record.actions),
    ...normalizePatterns(record.targets),
    ...normalizePatterns(record.environments),
  ].join('|');
  return createHash('sha256').update(normalized).digest('hex');
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizePatterns(patterns: string[] | undefined): string[] {
  return (patterns ?? []).map((pattern) => pattern.toLowerCase().trim()).sort();
}
