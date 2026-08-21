import type { TextCodec } from '@memnox/core';
import { ENCRYPTION_MODE, KeyringCodec, legacyKeyring } from './keyring-codec';

/** The pre-keyring codec, kept only so existing records stay readable. */
export class AesGcmCodec implements TextCodec {
  private readonly codec: KeyringCodec;

  constructor(secret: string) {
    // Permissive: this shape predates encryption being mandatory, and its stores
    // may still hold rows written before a key existed.
    this.codec = new KeyringCodec(legacyKeyring(secret), ENCRYPTION_MODE.PERMISSIVE);
  }

  encode(plaintext: string): string {
    return this.codec.encode(plaintext);
  }

  decode(stored: string): string {
    return this.codec.decode(stored);
  }
}
