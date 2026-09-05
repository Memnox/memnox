import { TOOL_CLASS } from '../discovery/classify';
import { VERB_TAG, type VerbTable } from './verb-table';

/**
 * The seed set. Compiled in rather than read from disk: these decide what gets asked
 * about, so they ship with the binary and change through review. A table read from a
 * writable path would be a permission an agent could grant itself by editing a file.
 */

const READ = TOOL_CLASS.READ;
const WRITE = TOOL_CLASS.WRITE;
const GONE = TOOL_CLASS.DESTRUCTIVE;
const PROD = VERB_TAG.PRODUCTION;
const SECRETS = VERB_TAG.SECRETS;

export const VERB_TABLES: readonly VerbTable[] = [
  {
    name: 'aws',
    credential: ['~/.aws/credentials', '~/.aws/config', 'AWS_ACCESS_KEY_ID'],
    headline: 'can modify infrastructure',
    verbs: [
      { match: 's3 rb **', class: GONE, alternative: 'aws s3 ls, then remove by hand' },
      {
        match: 's3 rm --recursive **',
        class: GONE,
        alternative: 'aws s3 rm one key at a time',
      },
      { match: 'iam delete-**', class: GONE, tags: [SECRETS] },
      { match: 'iam **', class: WRITE, tags: [SECRETS], note: 'changes who can do what' },
      { match: 'ec2 terminate-instances **', class: GONE },
      { match: 'rds delete-**', class: GONE },
      { match: 'cloudformation delete-stack **', class: GONE },
      {
        match: 'secretsmanager get-secret-value **',
        class: READ,
        tags: [SECRETS],
        note: 'reads a secret value',
      },
      { match: 'sts get-caller-identity', class: READ, note: 'who am I' },
      { match: 's3 ls **', class: READ },
      { match: 'describe-**', class: READ },
      { match: 'list-**', class: READ },
      { match: 'get-**', class: READ },
    ],
  },
  {
    name: 'gcloud',
    credential: ['~/.config/gcloud'],
    headline: 'can modify cloud projects',
    verbs: [
      { match: 'projects delete **', class: GONE },
      { match: 'sql instances delete **', class: GONE },
      { match: 'compute instances delete **', class: GONE },
      { match: 'deploy **', class: WRITE },
      { match: 'auth list', class: READ },
      { match: 'config list', class: READ },
      { match: 'list **', class: READ },
    ],
  },
  {
    name: 'az',
    credential: ['~/.azure/azureProfile.json'],
    headline: 'can modify subscriptions',
    verbs: [
      { match: 'group delete **', class: GONE },
      { match: 'vm delete **', class: GONE },
      { match: 'deployment **', class: WRITE },
      { match: 'account show', class: READ },
      { match: 'list **', class: READ },
    ],
  },
  {
    name: 'gh',
    credential: ['~/.config/gh/hosts.yml', 'GH_TOKEN', 'GITHUB_TOKEN'],
    headline: 'can merge pull requests and delete branches',
    verbs: [
      { match: 'repo delete **', class: GONE },
      { match: 'release delete **', class: GONE },
      { match: 'api -X DELETE **', class: GONE },
      {
        match: 'pr merge **',
        class: WRITE,
        alternative: 'gh pr review --request, and let a person merge',
      },
      { match: 'release create **', class: WRITE, tags: [PROD] },
      { match: 'secret set **', class: WRITE, tags: [SECRETS] },
      { match: 'repo edit **', class: WRITE },
      { match: 'pr create **', class: WRITE, note: 'opens a PR, merges nothing' },
      { match: 'auth status', class: READ },
      { match: 'pr view **', class: READ },
      { match: 'pr list **', class: READ },
      { match: 'api **', class: READ, note: 'read unless -X says otherwise' },
    ],
  },
  {
    name: 'kubectl',
    credential: ['~/.kube/config'],
    headline: 'can change what runs in your clusters',
    verbs: [
      { match: 'delete namespace **', class: GONE },
      { match: 'delete deployment **', class: GONE },
      { match: 'delete pvc **', class: GONE, note: 'takes the volume with it' },
      { match: 'delete **', class: GONE },
      { match: 'drain **', class: GONE },
      { match: 'apply **', class: WRITE },
      { match: 'rollout restart **', class: WRITE },
      { match: 'exec **', class: WRITE, note: 'a shell inside the cluster' },
      { match: 'get **', class: READ },
      { match: 'describe **', class: READ },
      { match: 'logs **', class: READ },
    ],
  },
  {
    name: 'terraform',
    credential: ['~/.terraform.d/credentials.tfrc.json'],
    headline: 'can apply infrastructure changes',
    verbs: [
      {
        match: 'destroy **',
        class: GONE,
        alternative: 'terraform plan -destroy, and read it',
      },
      {
        match: 'state rm **',
        class: GONE,
        note: 'the resource survives and is forgotten',
      },
      { match: 'apply **', class: WRITE, alternative: 'terraform plan' },
      { match: 'import **', class: WRITE },
      { match: 'plan **', class: READ },
      { match: 'show **', class: READ },
    ],
  },
  {
    name: 'docker',
    credential: ['~/.docker/config.json'],
    headline: 'can push images to your registries',
    verbs: [
      { match: 'system prune -a', class: GONE },
      { match: 'rmi -f **', class: GONE },
      { match: 'push **', class: WRITE, tags: [PROD] },
      { match: 'build **', class: WRITE, note: 'local' },
      { match: 'ps **', class: READ },
      { match: 'images **', class: READ },
    ],
  },
  {
    name: 'vercel',
    credential: ['~/.vercel/auth.json', 'VERCEL_TOKEN'],
    headline: 'can deploy to production',
    verbs: [
      { match: 'deploy --prod', class: WRITE, tags: [PROD], note: 'production deploy' },
      { match: '--prod', class: WRITE, tags: [PROD], note: 'production deploy' },
      { match: 'env rm **', class: GONE, tags: [SECRETS] },
      { match: 'domains rm **', class: GONE },
      { match: 'project rm **', class: GONE },
      { match: 'env add **', class: WRITE, tags: [SECRETS] },
      { match: 'deploy', class: WRITE, note: 'preview deploy' },
      { match: 'whoami', class: READ },
      { match: 'ls', class: READ },
      { match: 'list', class: READ },
      { match: 'inspect **', class: READ },
      { match: 'logs **', class: READ },
    ],
  },
  {
    name: 'railway',
    credential: ['~/.railway/config.json'],
    headline: 'can deploy',
    verbs: [
      { match: 'delete **', class: GONE },
      { match: 'up **', class: WRITE, tags: [PROD] },
      { match: 'status', class: READ },
    ],
  },
  {
    name: 'fly',
    credential: ['~/.fly/config.yml'],
    headline: 'can deploy',
    verbs: [
      { match: 'apps destroy **', class: GONE },
      { match: 'deploy **', class: WRITE, tags: [PROD] },
      { match: 'status', class: READ },
    ],
  },
  {
    name: 'heroku',
    credential: ['~/.heroku'],
    headline: 'can deploy',
    verbs: [
      { match: 'apps:destroy **', class: GONE },
      { match: 'releases:rollback **', class: WRITE, tags: [PROD] },
      { match: 'ps **', class: READ },
    ],
  },
  {
    name: 'netlify',
    credential: ['~/.netlify'],
    headline: 'can deploy',
    verbs: [
      { match: 'sites:delete **', class: GONE },
      { match: 'deploy --prod', class: WRITE, tags: [PROD] },
      { match: 'deploy **', class: WRITE },
      { match: 'status', class: READ },
    ],
  },
  {
    name: 'psql',
    credential: ['~/.pgpass', 'DATABASE_URL', 'PGPASSWORD'],
    headline: 'can reach a database',
    verbs: [
      { match: '-c **', class: WRITE, note: 'statement is read from the argument' },
      { match: '**', class: WRITE, note: 'an interactive session can do anything' },
    ],
  },
  {
    name: 'mysql',
    credential: ['~/.my.cnf', 'MYSQL_PWD', 'DATABASE_URL'],
    headline: 'can reach a database',
    verbs: [
      { match: '-e **', class: WRITE, note: 'statement is read from the argument' },
      { match: '**', class: WRITE },
    ],
  },
  {
    name: 'mongosh',
    credential: ['MONGODB_URI', 'DATABASE_URL'],
    headline: 'can reach a database',
    verbs: [
      { match: '--eval **', class: WRITE },
      { match: '**', class: WRITE },
    ],
  },
  {
    name: 'npm',
    credential: ['~/.npmrc', 'NPM_TOKEN'],
    headline: 'can publish packages',
    verbs: [
      { match: 'unpublish **', class: GONE },
      {
        match: 'publish **',
        class: WRITE,
        tags: [PROD],
        note: 'everyone can install it',
      },
      { match: 'install **', class: WRITE, note: 'runs install scripts' },
      { match: 'run **', class: WRITE },
      { match: 'ls **', class: READ },
      { match: 'view **', class: READ },
    ],
  },
  {
    name: 'stripe',
    credential: ['~/.config/stripe/config.toml', 'STRIPE_API_KEY'],
    headline: 'can move money',
    verbs: [
      { match: 'customers delete **', class: GONE },
      { match: 'refunds create **', class: WRITE, tags: [PROD], note: 'moves money' },
      { match: 'charges create **', class: WRITE, tags: [PROD], note: 'moves money' },
      { match: 'listen **', class: READ },
      { match: 'get **', class: READ },
    ],
  },
  {
    name: 'git',
    credential: ['~/.git-credentials', '~/.netrc'],
    headline: 'can push to your repositories',
    verbs: [
      {
        match: 'push --force **',
        class: GONE,
        alternative: 'push a branch and open a PR',
        note: 'rewrites history somebody may have pulled',
      },
      { match: 'push -f **', class: GONE, alternative: 'push a branch and open a PR' },
      { match: 'reset --hard **', class: GONE, note: 'discards uncommitted work' },
      { match: 'branch -D **', class: GONE },
      { match: 'clean -fd **', class: GONE },
      { match: 'push **', class: WRITE },
      { match: 'commit **', class: WRITE, note: 'local' },
      { match: 'status', class: READ },
      { match: 'log **', class: READ },
      { match: 'diff **', class: READ },
    ],
  },
  {
    name: 'playwright',
    credential: [],
    headline: 'can act on websites as you',
    verbs: [
      { match: 'test **', class: WRITE, note: 'drives a browser' },
      { match: '**', class: WRITE, note: 'drives a browser' },
    ],
  },
];

const BY_NAME = new Map(VERB_TABLES.map((table) => [table.name, table]));

export function verbTableFor(binary: string): VerbTable | null {
  return BY_NAME.get(binary) ?? null;
}

export function verbTableNames(): string[] {
  return [...BY_NAME.keys()];
}
