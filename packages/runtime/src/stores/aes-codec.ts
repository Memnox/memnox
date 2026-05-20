import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { TextCodec } from '@memnox/core';

const AES_ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const CIPHERTEXT_PREFIX = 'enc:v1:';

/**
 * Random-IV AES-256-GCM at rest. Deliberately NOT deterministic — encrypted
 * stores are loaded fully and matched in memory, so equality-searchable
 * ciphertext (the legacy trap) is never needed.
 */
export class AesGcmCodec implements TextCodec {
  private readonly key: Buffer;

  constructor(secret: string) {
    // Any passphrase length works; the key is its SHA-256.
    this.key = createHash('sha256').update(secret).digest();
  }

  encode(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(AES_ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${CIPHERTEXT_PREFIX}${Buffer.concat([iv, tag, encrypted]).toString('base64')}`;
  }

  decode(stored: string): string {
    // Pre-encryption rows read as-is so enabling a key is not a migration.
    if (!stored.startsWith(CIPHERTEXT_PREFIX)) return stored;
    const raw = Buffer.from(stored.slice(CIPHERTEXT_PREFIX.length), 'base64');
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + 16);
    const encrypted = raw.subarray(IV_BYTES + 16);
    const decipher = createDecipheriv(AES_ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }
}
