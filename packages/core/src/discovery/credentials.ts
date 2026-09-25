import { verbTableFor, type VerbTable } from '../verbs/index';
import { destructiveVerbs, externalStateVerbs } from '../verbs/verb-table';
import { PRODUCTION_HINTS } from './discovery.constants';
import type { MachineReader } from './ports';

/**
 * Credential files and what they let an agent do, read from structure: profile names,
 * host names and counts, and never a value. The one owner of every credential path list.
 */
export interface CredentialFinding {
  /** What it is, in the reader's words: "AWS", "GitHub CLI". */
  kind: string;
  path: string;
  /** Structural detail only: profile names, hosts, contexts. Never a secret. */
  detail?: string;
  /** How many things it holds, where counting is the honest summary. */
  count?: number;
}

/** Home paths opened to be fingerprinted, never kept: what leaves is a path and a hash. */
export const FINGERPRINTED_HOME_PATHS: readonly string[] = [
  '.aws/credentials',
  '.ssh/id_rsa',
  '.ssh/id_ed25519',
  '.kube/config',
  '.docker/config.json',
  '.npmrc',
  '.netrc',
  '.env',
];

/** The `.env` names people actually use, in the directories they actually work in. */
export const ENV_FILE_NAMES: readonly string[] = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
];

/** Credential files that live beside the work rather than in the home directory. */
export const PROJECT_CREDENTIAL_FILES: readonly string[] = [...ENV_FILE_NAMES, '.npmrc'];

type CredentialDetail = { detail?: string; count?: number };

interface CredentialSpec {
  kind: string;
  /** Relative to home. */
  paths: string[];
  /** Reads structure out of the file. Must never return a value from it. */
  detail?: (contents: string) => CredentialDetail;
}

/** Section headers in an INI-style file: `[profile-name]`. */
function iniSections(contents: string): string[] {
  return [...contents.matchAll(/^\s*\[([^\]]+)\]/gm)].map((match) =>
    (match[1] ?? '').replace(/^profile\s+/, '').trim(),
  );
}

/** A detail reader naming an INI file's sections under `label`. */
function buildSectionDetail(label: string): (contents: string) => CredentialDetail {
  return (contents) => {
    const names = iniSections(contents);
    if (names.length === 0) return {};
    return { detail: `${label}: ${names.join(', ')}`, count: names.length };
  };
}

/** Host keys in a YAML map, which is how gh and similar store their logins. */
function yamlHosts(contents: string): CredentialDetail {
  const hosts = [...contents.matchAll(/^([A-Za-z0-9.-]+):\s*$/gm)].map(
    (match) => match[1] ?? '',
  );
  if (hosts.length === 0) return {};
  return { detail: hosts.join(', '), count: hosts.length };
}

/** Context names in a kubeconfig, each counted once. */
function kubeContexts(contents: string): CredentialDetail {
  const contexts = [...contents.matchAll(/^\s*-?\s*name:\s*(\S+)/gm)].map(
    (match) => match[1] ?? '',
  );
  const unique = [...new Set(contexts)];
  if (unique.length === 0) return {};
  return { detail: `contexts: ${unique.join(', ')}`, count: unique.length };
}

/** Registry hosts in a Docker config, and never the `auth` beside each. */
function dockerRegistries(contents: string): CredentialDetail {
  try {
    // Only `auths` is read, and only its keys.
    const parsed = JSON.parse(contents) as { auths?: Record<string, unknown> };
    const hosts = Object.keys(parsed.auths ?? {});
    return hosts.length === 0 ? {} : { detail: hosts.join(', '), count: hosts.length };
  } catch {
    // A config we cannot parse still counts as present; only the detail is lost.
    return {};
  }
}

const SPECS: readonly CredentialSpec[] = [
  { kind: 'SSH key', paths: ['.ssh/id_ed25519', '.ssh/id_rsa', '.ssh/id_ecdsa'] },
  { kind: 'AWS', paths: ['.aws/credentials'], detail: buildSectionDetail('profiles') },
  { kind: 'AWS config', paths: ['.aws/config'], detail: buildSectionDetail('profiles') },
  { kind: 'Google Cloud', paths: ['.config/gcloud/credentials.db'] },
  { kind: 'Azure', paths: ['.azure/azureProfile.json'] },
  { kind: 'GitHub CLI', paths: ['.config/gh/hosts.yml'], detail: yamlHosts },
  { kind: 'Vercel', paths: ['.vercel/auth.json'] },
  { kind: 'Railway', paths: ['.railway/config.json'] },
  { kind: 'Fly.io', paths: ['.fly/config.yml'] },
  { kind: 'Netlify', paths: ['.netlify/config.json'] },
  { kind: 'Heroku', paths: ['.netrc'] },
  { kind: 'Kubernetes', paths: ['.kube/config'], detail: kubeContexts },
  { kind: 'Terraform Cloud', paths: ['.terraform.d/credentials.tfrc.json'] },
  { kind: 'Docker registries', paths: ['.docker/config.json'], detail: dockerRegistries },
  { kind: 'npm registry', paths: ['.npmrc'] },
  { kind: 'PyPI', paths: ['.pypirc'] },
  { kind: 'Cargo', paths: ['.cargo/credentials', '.cargo/credentials.toml'] },
  { kind: 'Stripe', paths: ['.config/stripe/config.toml'] },
  { kind: 'Git credentials', paths: ['.git-credentials'] },
];

/**
 * Counted, never read out: a `.env` is the credential file most likely to hold something
 * live, so the summary is how many variables it holds and how many are named like a key.
 */
export async function findEnvFiles(
  reader: MachineReader,
  projectDirs: readonly string[],
): Promise<EnvFinding[]> {
  const found: EnvFinding[] = [];
  for (const dir of projectDirs) {
    for (const name of ENV_FILE_NAMES) {
      const path = `${dir}/${name}`;
      const contents = await reader.read(path);
      if (contents === null) continue;
      found.push(readEnvFile(path, contents));
    }
  }
  return found;
}

export async function findCredentials(
  reader: MachineReader,
): Promise<CredentialFinding[]> {
  const home = reader.homeDir();
  const found: CredentialFinding[] = [];

  for (const spec of SPECS) {
    for (const relative of spec.paths) {
      const path = `${home}/${relative}`;
      if (!(await reader.exists(path))) continue;

      const finding: CredentialFinding = { kind: spec.kind, path };
      if (spec.detail !== undefined) {
        const contents = await reader.read(path);
        // The value is read here and never leaves: what is kept is a name, a host or a count.
        if (contents !== null) Object.assign(finding, spec.detail(contents));
      }
      found.push(finding);
    }
  }
  return found;
}

/** Names that look like a key. The heuristic is on the name; the value is never read. */
const KEY_LIKE = /_(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|API|DSN|URI)S?$/i;

/**
 * Names that are a credential whatever they end in. `DATABASE_URL` carries a password
 * in the middle of it, and a suffix rule alone would let the most common one through.
 */
const KNOWN_CREDENTIAL_NAMES = new Set([
  'DATABASE_URL',
  'MONGODB_URI',
  'REDIS_URL',
  'AWS_ACCESS_KEY_ID',
  'AWS_SESSION_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'VERCEL_TOKEN',
]);

export function looksLikeCredential(name: string): boolean {
  return KNOWN_CREDENTIAL_NAMES.has(name.toUpperCase()) || KEY_LIKE.test(name);
}

export interface EnvFinding {
  path: string;
  variables: number;
  /** How many are named like a credential. A count, never the names' values. */
  keyLike: number;
}

export function readEnvFile(path: string, contents: string): EnvFinding {
  const names = contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.split('=')[0]?.trim() ?? '')
    .filter((name) => name !== '');

  return {
    path,
    variables: names.length,
    keyLike: names.filter(looksLikeCredential).length,
  };
}

export interface AuthenticatedCli {
  name: string;
  /** The credential that makes it authenticated, by path or variable name. */
  via: string;
  /** The sentence the scan prints. */
  headline: string;
  /** Structural detail from the credential, e.g. profile or context names. */
  detail?: string;
  externalStateVerbs: number;
  destructiveVerbs: number;
  /** Set when a name looks like production. A guess, and printed as one. */
  productionLooking?: string;
}

/** A CLI context named `main` is the one people deploy from, so it reads as production too. */
const PRODUCTION_NAMES: readonly string[] = [...PRODUCTION_HINTS, 'main'];

/** Reported as "named like production", never as production. */
export function productionLooking(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  return detail
    .split(/[,\s:]+/)
    .find((word) => PRODUCTION_NAMES.some((name) => word.toLowerCase().includes(name)));
}

/**
 * A binary on PATH plus a credential it can read is an authenticated CLI, and that
 * pair is the whole finding: either alone is unremarkable.
 */
export function authenticatedClis(
  binaries: readonly string[],
  credentials: readonly CredentialFinding[],
  envNames: readonly string[] = [],
): AuthenticatedCli[] {
  const found: AuthenticatedCli[] = [];

  for (const binary of binaries) {
    const table: VerbTable | null = verbTableFor(binary);
    if (table === null) continue;

    const match = credentials.find((credential) =>
      table.credential.some(
        (source) => source.startsWith('~') && credential.path.endsWith(source.slice(1)),
      ),
    );
    const variable = table.credential.find(
      (source) => !source.startsWith('~') && envNames.includes(source),
    );
    const via = match?.path ?? variable;
    if (via === undefined) continue;

    const detail = match?.detail;
    const looking = productionLooking(detail);
    found.push({
      name: binary,
      via,
      headline: table.headline,
      ...(detail === undefined ? {} : { detail }),
      externalStateVerbs: externalStateVerbs(table).length,
      destructiveVerbs: destructiveVerbs(table).length,
      ...(looking === undefined ? {} : { productionLooking: looking }),
    });
  }
  return found;
}
