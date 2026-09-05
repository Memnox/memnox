import type { MachineReader } from './ports';
import { verbTableFor, type VerbTable } from '../verbs/index';
import { destructiveVerbs, externalStateVerbs } from '../verbs/verb-table';

/**
 * The headline of the whole product. A credential file is a fact; what it lets an
 * agent do is the sentence somebody repeats to a colleague. Everything here is read
 * from structure — profile names, host names, counts — and never from a value.
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

interface CredentialSpec {
  kind: string;
  /** Relative to home. */
  paths: string[];
  /** Reads structure out of the file. Must never return a value from it. */
  detail?: (contents: string) => { detail?: string; count?: number };
}

/** Section headers in an INI-style file: `[profile-name]`. */
function iniSections(contents: string): string[] {
  return [...contents.matchAll(/^\s*\[([^\]]+)\]/gm)].map((match) =>
    (match[1] as string).replace(/^profile\s+/, '').trim(),
  );
}

function named(label: string) {
  return (contents: string): { detail?: string; count?: number } => {
    const names = iniSections(contents);
    if (names.length === 0) return {};
    return { detail: `${label}: ${names.join(', ')}`, count: names.length };
  };
}

/** Host keys in a YAML map, which is how gh and similar store their logins. */
function yamlHosts(contents: string): { detail?: string; count?: number } {
  const hosts = [...contents.matchAll(/^([A-Za-z0-9.-]+):\s*$/gm)].map(
    (match) => match[1] as string,
  );
  if (hosts.length === 0) return {};
  return { detail: hosts.join(', '), count: hosts.length };
}

const SPECS: readonly CredentialSpec[] = [
  { kind: 'SSH key', paths: ['.ssh/id_ed25519', '.ssh/id_rsa', '.ssh/id_ecdsa'] },
  { kind: 'AWS', paths: ['.aws/credentials'], detail: named('profiles') },
  { kind: 'AWS config', paths: ['.aws/config'], detail: named('profiles') },
  { kind: 'Google Cloud', paths: ['.config/gcloud/credentials.db'] },
  { kind: 'Azure', paths: ['.azure/azureProfile.json'] },
  { kind: 'GitHub CLI', paths: ['.config/gh/hosts.yml'], detail: yamlHosts },
  { kind: 'Vercel', paths: ['.vercel/auth.json'] },
  { kind: 'Railway', paths: ['.railway/config.json'] },
  { kind: 'Fly.io', paths: ['.fly/config.yml'] },
  { kind: 'Netlify', paths: ['.netlify/config.json'] },
  { kind: 'Heroku', paths: ['.netrc'] },
  {
    kind: 'Kubernetes',
    paths: ['.kube/config'],
    detail: (contents) => {
      const contexts = [...contents.matchAll(/^\s*-?\s*name:\s*(\S+)/gm)].map(
        (match) => match[1] as string,
      );
      const unique = [...new Set(contexts)];
      if (unique.length === 0) return {};
      return { detail: `contexts: ${unique.join(', ')}`, count: unique.length };
    },
  },
  { kind: 'Terraform Cloud', paths: ['.terraform.d/credentials.tfrc.json'] },
  {
    kind: 'Docker registries',
    paths: ['.docker/config.json'],
    detail: (contents) => {
      try {
        const parsed = JSON.parse(contents) as { auths?: Record<string, unknown> };
        const hosts = Object.keys(parsed.auths ?? {});
        return hosts.length === 0
          ? {}
          : { detail: hosts.join(', '), count: hosts.length };
      } catch {
        // A config we cannot parse still counts as present; only the detail is lost.
        return {};
      }
    },
  },
  { kind: 'npm registry', paths: ['.npmrc'] },
  { kind: 'PyPI', paths: ['.pypirc'] },
  { kind: 'Cargo', paths: ['.cargo/credentials', '.cargo/credentials.toml'] },
  { kind: 'Stripe', paths: ['.config/stripe/config.toml'] },
  { kind: 'Git credentials', paths: ['.git-credentials'] },
];

/** The `.env` names people actually use, in the directories they actually work in. */
const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.production'];

/**
 * Counted, never read out. A `.env` is the credential file most likely to hold
 * something live, and the honest summary is how many variables it holds and how many
 * are named like a key — the values stay in the file.
 */
export async function findEnvFiles(
  reader: MachineReader,
  projectDirs: readonly string[],
): Promise<EnvFinding[]> {
  const found: EnvFinding[] = [];
  for (const dir of projectDirs) {
    for (const name of ENV_FILES) {
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
        /* The value is read here and never leaves: what is kept is a name, a host or
           a count. A report carrying the shape of somebody's key is the worst bug
           this product could ship. */
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

function looksLikeCredential(name: string): boolean {
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

const PRODUCTION_NAMES = ['prod', 'production', 'live', 'main'];

/** Reported as "named like production", never as production. */
export function productionLooking(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  const hit = detail
    .split(/[,\s:]+/)
    .find((word) => PRODUCTION_NAMES.some((name) => word.toLowerCase().includes(name)));
  return hit === undefined ? undefined : hit;
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
    if (match === undefined && variable === undefined) continue;

    const detail = match?.detail;
    const looking = productionLooking(detail);
    found.push({
      name: binary,
      via: match === undefined ? (variable as string) : match.path,
      headline: table.headline,
      ...(detail === undefined ? {} : { detail }),
      externalStateVerbs: externalStateVerbs(table).length,
      destructiveVerbs: destructiveVerbs(table).length,
      ...(looking === undefined ? {} : { productionLooking: looking }),
    });
  }
  return found;
}
