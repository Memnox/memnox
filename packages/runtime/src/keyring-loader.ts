import { readFile } from 'node:fs/promises';
import { PLAIN_TEXT_CODEC, type Logger, type TextCodec } from '@memnox/core';
import type { RuntimeConfig } from './config';
import { METRIC, type MetricsRegistry } from './metrics';
import {
  ENCRYPTION_MODE,
  KeyringCodec,
  legacyKeyring,
  type EncryptionKey,
  type EncryptionMode,
  type Keyring,
} from './stores/keyring-codec';

export interface KeySource {
  keyring?: Keyring;
  keyringFile?: string;
  dataKeyFile?: string;
  dataEncryptionKey?: string;
}

/** Keyring beats key file beats legacy flag, so nobody thinks they rotated when they did not. */
export async function resolveKeyring(config: KeySource): Promise<Keyring | null> {
  if (config.keyring !== undefined) return config.keyring;
  if (config.keyringFile !== undefined)
    return parseKeyring(await readFile(config.keyringFile, 'utf8'));
  if (config.dataKeyFile !== undefined) {
    return legacyKeyring((await readFile(config.dataKeyFile, 'utf8')).trim());
  }
  if (config.dataEncryptionKey !== undefined)
    return legacyKeyring(config.dataEncryptionKey);
  return null;
}

/** Legacy-only still works, but derives unsalted and cannot rotate. */
export function isLegacyOnly(keyring: Keyring): boolean {
  return keyring.keys.every((key) => key.salt === undefined || key.salt.length === 0);
}

export async function buildCodec(
  config: RuntimeConfig,
  metrics: MetricsRegistry,
  logger: Logger,
): Promise<TextCodec> {
  const keyring = await resolveKeyring(config);
  if (keyring === null) {
    if (config.dataEncryptionMode === ENCRYPTION_MODE.STRICT) {
      throw new Error('encryption mode is "strict" but no key source is configured');
    }
    return PLAIN_TEXT_CODEC;
  }
  const mode = resolveMode(config, keyring);
  if (mode === ENCRYPTION_MODE.PERMISSIVE) {
    logger.warn(
      'encryption is permissive — unencrypted records still read. Watch memnox_plaintext_records_read_total and switch to strict at zero.',
    );
  }
  if (isLegacyOnly(keyring)) {
    logger.warn(
      'using the legacy unsalted data key — run "memnox keys rewrap" onto a salted keyring.',
    );
  }
  return new KeyringCodec(keyring, mode, () =>
    metrics.increment(METRIC.PLAINTEXT_RECORDS_READ_TOTAL),
  );
}

/** A legacy key implies pre-encryption rows; a deliberate keyring does not. */
function resolveMode(config: RuntimeConfig, keyring: Keyring): EncryptionMode {
  if (config.dataEncryptionMode !== undefined) return config.dataEncryptionMode;
  return isLegacyOnly(keyring) ? ENCRYPTION_MODE.PERMISSIVE : ENCRYPTION_MODE.STRICT;
}

function parseKeyring(contents: string): Keyring {
  const raw: unknown = JSON.parse(contents);
  if (typeof raw !== 'object' || raw === null)
    throw new Error('keyring file must be a JSON object');
  const candidate = raw as { activeKeyId?: unknown; keys?: unknown };
  if (typeof candidate.activeKeyId !== 'string') {
    throw new Error('keyring file requires a string "activeKeyId"');
  }
  if (!Array.isArray(candidate.keys) || candidate.keys.length === 0) {
    throw new Error('keyring file requires a non-empty "keys" array');
  }
  return { activeKeyId: candidate.activeKeyId, keys: candidate.keys.map(parseKey) };
}

function parseKey(raw: unknown, index: number): EncryptionKey {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`keyring key ${index} must be an object`);
  }
  const candidate = raw as { id?: unknown; secret?: unknown; salt?: unknown };
  if (typeof candidate.id !== 'string' || typeof candidate.secret !== 'string') {
    throw new Error(`keyring key ${index} requires string "id" and "secret"`);
  }
  return {
    id: candidate.id,
    secret: candidate.secret,
    ...(typeof candidate.salt === 'string' ? { salt: candidate.salt } : {}),
  };
}
