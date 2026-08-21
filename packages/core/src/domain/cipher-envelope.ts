/** `enc:<keyId>:<base64>` — the key id rides along, so rotation is a rewrap, not downtime. */
export const ENVELOPE_PREFIX = 'enc:';
const SEGMENT_SEPARATOR = ':';
/** `enc`, the key id, and the payload — the payload may not contain a separator. */
const ENVELOPE_SEGMENTS = 3;
/** The pre-keyring format, whose key id was a literal format version. */
export const LEGACY_KEY_ID = 'v1';
/** Key ids appear in ciphertext, so keep them to something a log can carry safely. */
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export interface CipherEnvelope {
  keyId: string;
  /** base64 of iv | authTag | ciphertext — the codec owns that layout. */
  payload: string;
}

export function isValidKeyId(keyId: string): boolean {
  return KEY_ID_PATTERN.test(keyId);
}

export function formatEnvelope(envelope: CipherEnvelope): string {
  return `${ENVELOPE_PREFIX}${envelope.keyId}${SEGMENT_SEPARATOR}${envelope.payload}`;
}

/** Null for anything unenveloped; the caller decides if plaintext is acceptable. */
export function parseEnvelope(stored: string): CipherEnvelope | null {
  if (!stored.startsWith(ENVELOPE_PREFIX)) return null;
  const segments = stored.split(SEGMENT_SEPARATOR);
  if (segments.length !== ENVELOPE_SEGMENTS) return null;
  const keyId = segments[1];
  const payload = segments[2];
  if (keyId === undefined || payload === undefined) return null;
  if (!isValidKeyId(keyId)) return null;
  return { keyId, payload };
}

export function isEncrypted(stored: string): boolean {
  return parseEnvelope(stored) !== null;
}
