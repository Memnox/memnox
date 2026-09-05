import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import type { MemnoxEvent } from './event';

/**
 * A period of history, signed, so an auditor is looking at evidence rather than at a
 * file somebody could have edited. This is the compliance line item: without it the
 * answer to "how do you control what AI agents do in production" is a PDF.
 */

export const BUNDLE_VERSION = 1;

export interface BundleRange {
  from: string;
  to: string;
}

export interface Bundle {
  version: number;
  /** The period this covers. An export that did not say would be worse than none. */
  range: BundleRange;
  createdAt: string;
  events: number;
  /** Hash over the events, so the signature covers content and not just a header. */
  digest: string;
  /** What was deliberately left out, named rather than silently dropped. */
  excluded: string[];
  signature?: string;
  publicKey?: string;
}

/** One event per line, in order. The same bytes are what gets hashed and signed. */
export function serializeEvents(events: readonly MemnoxEvent[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

export function digestOf(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

export interface BundleKeys {
  privateKeyPem: string;
  publicKeyPem: string;
}

/**
 * Ed25519, generated locally and never sent. The private half signs; the public half
 * travels with the bundle so a verifier needs nothing from us.
 */
export function generateKeys(): BundleKeys {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

export interface BuildBundleInput {
  events: readonly MemnoxEvent[];
  range: BundleRange;
  createdAt: string;
  excluded?: string[];
  keys?: BundleKeys;
}

export function buildBundle(input: BuildBundleInput): { header: Bundle; body: string } {
  const body = serializeEvents(input.events);
  const header: Bundle = {
    version: BUNDLE_VERSION,
    range: input.range,
    createdAt: input.createdAt,
    events: input.events.length,
    digest: digestOf(body),
    excluded: input.excluded ?? [],
  };

  if (input.keys !== undefined) {
    // Signed over the header without its own signature, so the range and the count
    // are covered too — a bundle whose period could be edited proves nothing.
    const signature = sign(
      null,
      Buffer.from(signedPayload(header)),
      input.keys.privateKeyPem,
    );
    header.signature = signature.toString('base64');
    header.publicKey = input.keys.publicKeyPem;
  }
  return { header, body };
}

function signedPayload(header: Bundle): string {
  return JSON.stringify({
    version: header.version,
    range: header.range,
    createdAt: header.createdAt,
    events: header.events,
    digest: header.digest,
    excluded: header.excluded,
  });
}

export const VERIFY_RESULT = {
  VALID: 'valid',
  /** The events do not hash to what the header claims. */
  TAMPERED: 'tampered',
  /** The signature does not check out against the key that travelled with it. */
  FORGED: 'forged',
  /** No signature at all. Readable, and not evidence. */
  UNSIGNED: 'unsigned',
} as const;

export type VerifyResult = (typeof VERIFY_RESULT)[keyof typeof VERIFY_RESULT];

export interface Verification {
  result: VerifyResult;
  /** What a person should be told, in one line. */
  detail: string;
}

/**
 * Checked in the order that matters: content first, then the signature. A bundle whose
 * events were edited must not be reported as merely unsigned.
 */
export function verifyBundle(header: Bundle, body: string): Verification {
  if (digestOf(body) !== header.digest) {
    return {
      result: VERIFY_RESULT.TAMPERED,
      detail: 'the events do not match the digest in the header — this has been edited',
    };
  }
  if (header.signature === undefined || header.publicKey === undefined) {
    return {
      result: VERIFY_RESULT.UNSIGNED,
      detail: `${header.events} event(s), content intact, but nothing signed it`,
    };
  }

  const ok = verify(
    null,
    Buffer.from(signedPayload(header)),
    header.publicKey,
    Buffer.from(header.signature, 'base64'),
  );
  return ok
    ? {
        result: VERIFY_RESULT.VALID,
        detail: `${header.events} event(s) from ${header.range.from} to ${header.range.to}, signature checks out`,
      }
    : {
        result: VERIFY_RESULT.FORGED,
        detail: 'the signature does not check out against the key in this bundle',
      };
}
