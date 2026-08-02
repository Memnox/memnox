import type { TextCodec } from '@memnox/core';
import { ENCRYPTION_MODE, KeyringCodec, legacyKeyring } from './keyring-codec';

/**
 * The pre-keyring codec: one passphrase, an unsalted SHA-256 derivation, and a
 * literal `v1` in place of a key id. Kept so existing `--data-key` deployments
 * keep reading their own records; new deployments should configure a keyring and
 * run `memnox keys rewrap` onto a salted key.
 *
 * @deprecated Use KeyringCodec.
 */
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
