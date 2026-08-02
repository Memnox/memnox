import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import {
  formatEnvelope,
  isValidKeyId,
  LEGACY_KEY_ID,
  parseEnvelope,
  type TextCodec,
} from '@memnox/core';

const AES_ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
/** ~32 MiB of work per derivation, paid once per key at construction. */
const SCRYPT_COST = 32_768;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELISM = 1;
/** Node's default maxmem sits exactly on the boundary for these parameters. */
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;

/**
 * What an unenveloped value means. `permissive` reads and counts it so enabling
 * encryption is not a migration; the count reaching zero is the cue for `strict`.
 */
export const ENCRYPTION_MODE = {
  OFF: 'off',
  PERMISSIVE: 'permissive',
  STRICT: 'strict',
} as const;

export type EncryptionMode = (typeof ENCRYPTION_MODE)[keyof typeof ENCRYPTION_MODE];

export interface EncryptionKey {
  id: string;
  /** Passphrase or high-entropy secret; the KDF handles either. */
  secret: string;
  /** So two deployments sharing a passphrase never share a key. Legacy v1 has none. */
  salt?: string;
}

export interface Keyring {
  /** The key new writes use; every other key is kept for reads. */
  activeKeyId: string;
  keys: readonly EncryptionKey[];
}

/** Loud, because the alternative is silent data loss. */
export class UnknownEncryptionKeyError extends Error {
  constructor(readonly keyId: string) {
    super(
      `record was encrypted with key "${keyId}", which is not in the keyring. ` +
        'Restore that key to read it, or rewrap the store before retiring a key.',
    );
    this.name = 'UnknownEncryptionKeyError';
  }
}

export class PlaintextRecordError extends Error {
  constructor() {
    super(
      'refusing to read an unencrypted record while encryption is strict. ' +
        'Set the encryption mode to "permissive" and run "memnox keys rewrap" to migrate.',
    );
    this.name = 'PlaintextRecordError';
  }
}

/**
 * AES-256-GCM at rest, random IV per record. Deliberately NOT deterministic —
 * stores are matched in memory, so searchable ciphertext (the legacy trap) is
 * never needed.
 */
export class KeyringCodec implements TextCodec {
  private readonly derived = new Map<string, Buffer>();
  private readonly activeKeyId: string;

  constructor(
    keyring: Keyring,
    private readonly mode: EncryptionMode = ENCRYPTION_MODE.STRICT,
    /** Called per plaintext read in permissive mode; the composition root counts it. */
    private readonly onPlaintextRead: () => void = () => undefined,
  ) {
    if (keyring.keys.length === 0) throw new Error('keyring requires at least one key');
    for (const key of keyring.keys) {
      if (!isValidKeyId(key.id)) {
        throw new Error(
          `invalid encryption key id "${key.id}" — use [a-z0-9_-], 32 chars max`,
        );
      }
      // Derived once: scrypt on every read would be a denial-of-service surface.
      this.derived.set(key.id, deriveKey(key));
    }
    if (!this.derived.has(keyring.activeKeyId)) {
      throw new Error(
        `active key "${keyring.activeKeyId}" is not present in the keyring`,
      );
    }
    this.activeKeyId = keyring.activeKeyId;
  }

  encode(plaintext: string): string {
    return this.encodeWith(plaintext, this.activeKeyId);
  }

  /** Rewrap re-encodes under a named key; everything else writes the active one. */
  encodeWith(plaintext: string, keyId: string): string {
    const key = this.keyFor(keyId);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(AES_ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const payload = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      'base64',
    );
    return formatEnvelope({ keyId, payload });
  }

  decode(stored: string): string {
    const envelope = parseEnvelope(stored);
    if (envelope === null) {
      if (this.mode === ENCRYPTION_MODE.STRICT) throw new PlaintextRecordError();
      this.onPlaintextRead();
      return stored;
    }
    const key = this.keyFor(envelope.keyId);
    const raw = Buffer.from(envelope.payload, 'base64');
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
    const encrypted = raw.subarray(IV_BYTES + AUTH_TAG_BYTES);
    const decipher = createDecipheriv(AES_ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }

  /** Which key a stored value names, so rewrap can skip what is already current. */
  keyIdOf(stored: string): string | null {
    const envelope = parseEnvelope(stored);
    return envelope === null ? null : envelope.keyId;
  }

  get activeKey(): string {
    return this.activeKeyId;
  }

  private keyFor(keyId: string): Buffer {
    const key = this.derived.get(keyId);
    if (key === undefined) throw new UnknownEncryptionKeyError(keyId);
    return key;
  }
}

/** Legacy v1 is an unsalted SHA-256, kept only so older records still read. */
function deriveKey(key: EncryptionKey): Buffer {
  if (key.id === LEGACY_KEY_ID) {
    return createHash('sha256').update(key.secret).digest();
  }
  if (key.salt === undefined || key.salt.length === 0) {
    throw new Error(`encryption key "${key.id}" requires a salt`);
  }
  return scryptSync(key.secret, key.salt, KEY_BYTES, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELISM,
    maxmem: SCRYPT_MAX_MEMORY,
  });
}

/** A `--data-key` deployment: one legacy key, still readable, due for a rewrap. */
export function legacyKeyring(secret: string): Keyring {
  return { activeKeyId: LEGACY_KEY_ID, keys: [{ id: LEGACY_KEY_ID, secret }] };
}
