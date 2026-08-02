import { describe, expect, it, vi } from 'vitest';
import { isEncrypted, LEGACY_KEY_ID, parseEnvelope } from '@memnox/core';
import { AesGcmCodec } from '../src/stores/aes-codec';
import {
  ENCRYPTION_MODE,
  KeyringCodec,
  legacyKeyring,
  PlaintextRecordError,
  UnknownEncryptionKeyError,
  type Keyring,
} from '../src/stores/keyring-codec';

// Assembled at runtime so no credential-shaped literal exists in this file.
const SECRET_ONE = ['keyring', 'secret', 'one'].join('-');
const SECRET_TWO = ['keyring', 'secret', 'two'].join('-');
const SALT_ONE = ['salt', 'one'].join('-');
const SALT_TWO = ['salt', 'two'].join('-');

const KEY_ONE = { id: 'k1', secret: SECRET_ONE, salt: SALT_ONE };
const KEY_TWO = { id: 'k2', secret: SECRET_TWO, salt: SALT_TWO };

function keyring(activeKeyId: string, keys = [KEY_ONE, KEY_TWO]): Keyring {
  return { activeKeyId, keys };
}

describe('cipher envelope', () => {
  it('round-trips a key id and payload', () => {
    expect(parseEnvelope('enc:k1:cGF5bG9hZA==')).toEqual({
      keyId: 'k1',
      payload: 'cGF5bG9hZA==',
    });
  });

  it('reads the legacy v1 prefix as a key id', () => {
    const envelope = parseEnvelope('enc:v1:cGF5bG9hZA==');

    expect(envelope).not.toBeNull();
    expect(envelope === null ? '' : envelope.keyId).toBe(LEGACY_KEY_ID);
  });

  it('treats anything else as not an envelope', () => {
    expect(isEncrypted('plain text')).toBe(false);
    expect(isEncrypted('enc:no-payload')).toBe(false);
    expect(isEncrypted('enc:BAD KEY:payload')).toBe(false);
  });
});

describe('keyring codec', () => {
  it('round-trips under the active key', () => {
    const codec = new KeyringCodec(keyring('k1'));

    const stored = codec.encode('team decision');

    expect(stored.startsWith('enc:k1:')).toBe(true);
    expect(codec.decode(stored)).toBe('team decision');
  });

  it('never produces the same ciphertext twice for one plaintext', () => {
    const codec = new KeyringCodec(keyring('k1'));

    // Deterministic ciphertext is the legacy scar this codec exists to avoid.
    expect(codec.encode('same')).not.toBe(codec.encode('same'));
  });

  it('reads a record written under a retired key while writing the active one', () => {
    const codec = new KeyringCodec(keyring('k2'));
    const old = codec.encodeWith('written earlier', 'k1');

    expect(codec.decode(old)).toBe('written earlier');
    expect(codec.encode('written now').startsWith('enc:k2:')).toBe(true);
  });

  it('throws rather than silently losing a record whose key is gone', () => {
    const codec = new KeyringCodec(keyring('k1', [KEY_ONE]));

    expect(() => codec.decode('enc:k9:cGF5bG9hZA==')).toThrow(UnknownEncryptionKeyError);
  });

  it('refuses an active key that is not in the keyring', () => {
    expect(() => new KeyringCodec(keyring('missing', [KEY_ONE]))).toThrow(/not present/);
  });

  it('requires a salt on anything but the legacy key', () => {
    expect(
      () =>
        new KeyringCodec({ activeKeyId: 'k1', keys: [{ id: 'k1', secret: SECRET_ONE }] }),
    ).toThrow(/requires a salt/);
  });

  it('derives different keys from one passphrase under different salts', () => {
    const first = new KeyringCodec({
      activeKeyId: 'k1',
      keys: [{ id: 'k1', secret: SECRET_ONE, salt: SALT_ONE }],
    });
    const second = new KeyringCodec({
      activeKeyId: 'k1',
      keys: [{ id: 'k1', secret: SECRET_ONE, salt: SALT_TWO }],
    });

    expect(() => second.decode(first.encode('shared phrase'))).toThrow();
  });

  it('rejects a key id that would not be safe in a log line', () => {
    expect(
      () =>
        new KeyringCodec({
          activeKeyId: 'bad id',
          keys: [{ id: 'bad id', secret: SECRET_ONE, salt: SALT_ONE }],
        }),
    ).toThrow(/invalid encryption key id/);
  });
});

describe('plaintext handling', () => {
  it('passes a pre-encryption record through and counts it when permissive', () => {
    const onPlaintextRead = vi.fn();
    const codec = new KeyringCodec(
      keyring('k1'),
      ENCRYPTION_MODE.PERMISSIVE,
      onPlaintextRead,
    );

    expect(codec.decode('written before encryption')).toBe('written before encryption');
    expect(onPlaintextRead).toHaveBeenCalledOnce();
  });

  it('refuses a plaintext record when strict', () => {
    const codec = new KeyringCodec(keyring('k1'), ENCRYPTION_MODE.STRICT);

    expect(() => codec.decode('written before encryption')).toThrow(PlaintextRecordError);
  });

  it('never counts a plaintext read for a record that was encrypted', () => {
    const onPlaintextRead = vi.fn();
    const codec = new KeyringCodec(
      keyring('k1'),
      ENCRYPTION_MODE.PERMISSIVE,
      onPlaintextRead,
    );

    codec.decode(codec.encode('encrypted'));

    expect(onPlaintextRead).not.toHaveBeenCalled();
  });
});

describe('legacy --data-key compatibility', () => {
  it('still reads records the old codec wrote', () => {
    const legacy = new AesGcmCodec(SECRET_ONE);
    const stored = legacy.encode('written by the old codec');

    const codec = new KeyringCodec(legacyKeyring(SECRET_ONE), ENCRYPTION_MODE.PERMISSIVE);

    expect(stored.startsWith('enc:v1:')).toBe(true);
    expect(codec.decode(stored)).toBe('written by the old codec');
  });

  it('lets a rewrap move a legacy record onto a salted key', () => {
    const legacy = new AesGcmCodec(SECRET_ONE);
    const stored = legacy.encode('due for rotation');

    const codec = new KeyringCodec(
      { activeKeyId: 'k2', keys: [{ id: 'v1', secret: SECRET_ONE }, KEY_TWO] },
      ENCRYPTION_MODE.PERMISSIVE,
    );
    const rewrapped = codec.encode(codec.decode(stored));

    expect(codec.keyIdOf(stored)).toBe(LEGACY_KEY_ID);
    expect(codec.keyIdOf(rewrapped)).toBe('k2');
    expect(codec.decode(rewrapped)).toBe('due for rotation');
  });
});
