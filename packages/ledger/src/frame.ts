import { createHash } from 'node:crypto';
import type { ContextTrust } from '@memnox/core';
import type { FrameKind } from './ledger.constants';
import { DEFAULT_ALLOW_SAMPLE_RATE } from './ledger.constants';

/**
 * Arguments hashed, results summarised. A ledger that stores what an agent read
 * becomes the thing worth stealing, on a laptop, unencrypted.
 */
export interface Frame {
  id: string;
  sessionId: string;
  agentId: string;
  decisionId?: string;
  at: string;
  kind: FrameKind;
  summary: string;
  payloadDigest?: string;
  contextTrust?: ContextTrust;
}

export function digest(payload: string): string {
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export interface SamplingPolicy {
  /** Full fidelity on anything that did not simply proceed. */
  keepEverythingUnlessAllowed: true;
  allowSampleRate: number;
}

export const DEFAULT_SAMPLING: SamplingPolicy = {
  keepEverythingUnlessAllowed: true,
  allowSampleRate: DEFAULT_ALLOW_SAMPLE_RATE,
};

/**
 * Deterministic sampling off the decision id rather than a random draw, so a replay of
 * the same day keeps the same frames and a report is reproducible.
 */
export function keepFrame(
  wasAllowed: boolean,
  decisionId: string,
  sampling: SamplingPolicy = DEFAULT_SAMPLING,
): boolean {
  if (!wasAllowed) return true;
  const bucket = parseInt(digest(decisionId).slice(0, 4), 16) / 0xffff;
  return bucket < sampling.allowSampleRate;
}

export interface FrameStore {
  append(frame: Frame): Promise<void>;
  bySession(sessionId: string): Promise<Frame[]>;
  /** Frames older than the cutoff are dropped: retention is a setting with a default. */
  prune(before: string): Promise<number>;
}

/** One session, one timeline, in the order things happened. */
export function timelineOf(frames: readonly Frame[]): Frame[] {
  return [...frames].sort((a, b) => a.at.localeCompare(b.at));
}
