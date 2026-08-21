import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PLAINTEXT_KEY_ID } from '@memnox/postgres';
import type { KeyringCodec } from './stores/keyring-codec';
import { isFileMissing } from './file-errors';

/** JSON stores encode their whole body, the audit log per line; mixing them corrupts it. */
const FILE_LAYOUT = {
  WHOLE: 'whole',
  LINES: 'lines',
} as const;

type FileLayout = (typeof FILE_LAYOUT)[keyof typeof FILE_LAYOUT];

interface EncryptedFile {
  name: string;
  layout: FileLayout;
}

/** Every local store file the codec touches, including policy history. */
export const ENCRYPTED_FILES: readonly EncryptedFile[] = [
  { name: 'agents.json', layout: FILE_LAYOUT.WHOLE },
  { name: 'decisions.json', layout: FILE_LAYOUT.WHOLE },
  { name: 'approvals.json', layout: FILE_LAYOUT.WHOLE },
  { name: 'policy-history.json', layout: FILE_LAYOUT.WHOLE },
  { name: 'audit.jsonl', layout: FILE_LAYOUT.LINES },
];

export interface RewrapResult {
  /** File or table name, so a report names what it touched. */
  source: string;
  values: number;
  rewrapped: number;
}

export interface KeyUsageResult {
  source: string;
  byKeyId: Record<string, number>;
}

/** Null when already on the active key; shared so file and SQL paths skip identically. */
export function recodeValue(codec: KeyringCodec, stored: string): string | null {
  if (codec.keyIdOf(stored) === codec.activeKey) return null;
  return codec.encode(codec.decode(stored));
}

export async function rewrapDataDir(
  dataDir: string,
  codec: KeyringCodec,
): Promise<RewrapResult[]> {
  const results: RewrapResult[] = [];
  for (const file of ENCRYPTED_FILES) {
    const result = await rewrapFile(join(dataDir, file.name), file.layout, codec);
    if (result !== null) results.push({ ...result, source: file.name });
  }
  return results;
}

export async function keyUsageForDataDir(
  dataDir: string,
  codec: KeyringCodec,
): Promise<KeyUsageResult[]> {
  const results: KeyUsageResult[] = [];
  for (const file of ENCRYPTED_FILES) {
    const contents = await readIfPresent(join(dataDir, file.name));
    if (contents === null) continue;
    const byKeyId: Record<string, number> = {};
    for (const value of split(contents, file.layout)) {
      const keyId = codec.keyIdOf(value) ?? PLAINTEXT_KEY_ID;
      byKeyId[keyId] = (byKeyId[keyId] ?? 0) + 1;
    }
    results.push({ source: file.name, byKeyId });
  }
  return results;
}

async function rewrapFile(
  path: string,
  layout: FileLayout,
  codec: KeyringCodec,
): Promise<Omit<RewrapResult, 'source'> | null> {
  const contents = await readIfPresent(path);
  if (contents === null) return null;
  const values = split(contents, layout);
  let rewrapped = 0;
  const next = values.map((value) => {
    const recoded = recodeValue(codec, value);
    if (recoded === null) return value;
    rewrapped += 1;
    return recoded;
  });
  if (rewrapped > 0) {
    // Rename, so an interrupted rewrap leaves no half-converted store.
    const staging = `${path}.rewrap`;
    await writeFile(staging, joinValues(next, layout), 'utf8');
    await rename(staging, path);
  }
  return { values: values.length, rewrapped };
}

function split(contents: string, layout: FileLayout): string[] {
  if (layout === FILE_LAYOUT.WHOLE) return [contents];
  return contents.split('\n').filter((line) => line.trim().length > 0);
}

function joinValues(values: string[], layout: FileLayout): string {
  if (layout === FILE_LAYOUT.WHOLE) return values.join('');
  return `${values.join('\n')}\n`;
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    // A store that was never written is not an error — nothing to rewrap.
    if (isFileMissing(error)) return null;
    throw error;
  }
}
