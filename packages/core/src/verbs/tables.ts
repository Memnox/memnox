/**
 * The seed verb tables, compiled in rather than read from disk, because a table read from a
 * writable path would be a permission an agent could grant itself by editing a file.
 */
import type { VerbTable } from './verb-table';
import { CLOUD_TABLES } from './tables/cloud';
import { CODE_TABLES } from './tables/code';
import { DATA_TABLES } from './tables/data';
import { DEPLOY_TABLES } from './tables/deploy';

const ALL = [...CLOUD_TABLES, ...CODE_TABLES, ...DATA_TABLES, ...DEPLOY_TABLES];
// The order a scan has always listed them in, whichever file each now lives in.
const ORDER = [
  'aws',
  'gcloud',
  'az',
  'gh',
  'kubectl',
  'terraform',
  'docker',
  'vercel',
  'railway',
  'fly',
  'heroku',
  'netlify',
  'psql',
  'mysql',
  'mongosh',
  'npm',
  'stripe',
  'git',
  'playwright',
];

export const VERB_TABLES: readonly VerbTable[] = ORDER.map((name) => {
  const table = ALL.find((each) => each.name === name);
  if (table === undefined) throw new Error(`no verb table named ${name}`);
  return table;
});

const BY_NAME = new Map(VERB_TABLES.map((table) => [table.name, table]));

export function verbTableFor(binary: string): VerbTable | null {
  return BY_NAME.get(binary) ?? null;
}

export function verbTableNames(): string[] {
  return [...BY_NAME.keys()];
}
