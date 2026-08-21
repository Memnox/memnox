import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Deterministic and offline: file existence only, never a model. */
interface DetectedStack {
  /** What was found, in the repository's own terms — shown so a choice can be argued with. */
  signals: string[];
  packs: string[];
}

/** Every repository gets these: destructive shell and production damage are universal. */
const BASELINE_PACKS = ['production-safety', 'terminal-safety'];

interface Signal {
  label: string;
  packs: string[];
  /** Directories or files whose presence proves the signal. */
  paths?: string[];
  /** Dependency name fragments in package.json. */
  dependencies?: string[];
}

const SIGNALS: readonly Signal[] = [
  {
    label: 'payments',
    packs: ['payments', 'money-movement'],
    paths: ['payment', 'payments', 'billing'],
    dependencies: ['stripe', 'braintree', 'paypal', '@paddle'],
  },
  {
    label: 'database migrations',
    packs: ['data-privacy'],
    paths: ['migrations', 'prisma', 'drizzle', 'db/migrate'],
    dependencies: ['prisma', 'drizzle-orm', 'typeorm', 'knex', 'sequelize'],
  },
  {
    label: 'authentication',
    packs: ['auth-and-secrets'],
    paths: ['.env', '.env.local', 'auth'],
    dependencies: ['next-auth', '@clerk', 'passport', '@auth/', 'lucia'],
  },
  {
    label: 'CI/CD',
    packs: ['supply-chain'],
    paths: ['.github/workflows', '.gitlab-ci.yml', '.circleci'],
  },
  {
    label: 'infrastructure as code',
    packs: ['infrastructure'],
    paths: ['Dockerfile', 'docker-compose.yml', 'terraform', 'k8s', 'helm'],
  },
  {
    label: 'AWS',
    packs: ['aws'],
    paths: ['.aws'],
    dependencies: ['aws-sdk', '@aws-sdk', 'aws-cdk'],
  },
  {
    label: 'git history',
    packs: ['repository-protection'],
    paths: ['.git'],
  },
];

export function detectStack(dir: string): DetectedStack {
  const dependencies = readDependencyNames(dir);
  const signals: string[] = [];
  const packs = new Set(BASELINE_PACKS);

  for (const signal of SIGNALS) {
    if (!matches(dir, signal, dependencies)) continue;
    signals.push(signal.label);
    for (const pack of signal.packs) packs.add(pack);
  }
  return { signals, packs: [...packs] };
}

function matches(dir: string, signal: Signal, dependencies: string[]): boolean {
  for (const path of signal.paths ?? []) {
    if (existsSync(join(dir, path))) return true;
  }
  for (const fragment of signal.dependencies ?? []) {
    if (dependencies.some((name) => name.startsWith(fragment))) return true;
  }
  return false;
}

/** Dependency names only — versions and scripts say nothing about what to govern. */
function readDependencyNames(dir: string): string[] {
  const manifest = join(dir, 'package.json');
  if (!existsSync(manifest)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return [];
    const record = parsed as Record<string, unknown>;
    return [
      ...dependencyNames(record['dependencies']),
      ...dependencyNames(record['devDependencies']),
    ];
  } catch {
    return []; // An unreadable manifest means no signal, never a failed setup.
  }
}

function dependencyNames(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return [];
  return Object.keys(value as Record<string, unknown>);
}
