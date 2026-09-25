/** Hosting platforms: where a command puts code in front of users. */
import { TOOL_CLASS } from '../../discovery/classify';
import { VERB_TAG, type VerbTable } from '../verb-table';

const READ = TOOL_CLASS.READ;
const WRITE = TOOL_CLASS.WRITE;
const GONE = TOOL_CLASS.DESTRUCTIVE;
const PROD = VERB_TAG.PRODUCTION;
const SECRETS = VERB_TAG.SECRETS;

export const DEPLOY_TABLES: readonly VerbTable[] = [
  {
    name: 'vercel',
    credential: ['~/.vercel/auth.json', 'VERCEL_TOKEN'],
    headline: 'can deploy to production',
    globalFlags: [
      '--scope',
      '-S',
      '--token',
      '-t',
      '--cwd',
      '-A',
      '--local-config',
      '-Q',
      '--global-config',
    ],
    globalSwitches: ['--debug', '-d'],
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
      {
        match: 'delete **',
        class: GONE,
        alternative: 'railway status, and let a person delete it',
      },
      {
        match: 'down **',
        class: GONE,
        note: 'removes the latest deployment',
        alternative: 'railway logs, and let a person roll back',
      },
      { match: 'volume delete **', class: GONE },
      { match: 'environment delete **', class: GONE },
      { match: 'up **', class: WRITE, tags: [PROD], alternative: 'railway status' },
      {
        match: 'redeploy **',
        class: WRITE,
        tags: [PROD],
        alternative: 'railway logs, and let the deploy pipeline redeploy',
      },
      { match: 'deploy **', class: WRITE, note: 'deploys a template' },
      { match: 'restart **', class: WRITE, tags: [PROD] },
      { match: 'scale **', class: WRITE, tags: [PROD] },
      {
        match: 'variables --set **',
        class: WRITE,
        tags: [SECRETS],
        alternative: 'railway variables --kv, to read them',
      },
      { match: 'variables -s **', class: WRITE, tags: [SECRETS] },
      { match: 'variable set **', class: WRITE, tags: [SECRETS] },
      { match: 'variable delete **', class: GONE, tags: [SECRETS] },
      // Printing them is still a read, and the values are secrets.
      { match: 'variables **', class: READ, tags: [SECRETS], note: 'prints the values' },
      {
        match: 'variable list **',
        class: READ,
        tags: [SECRETS],
        note: 'prints the values',
      },
      { match: 'environment new **', class: WRITE },
      { match: 'volume add **', class: WRITE },
      { match: 'volume update **', class: WRITE },
      { match: 'volume attach **', class: WRITE },
      { match: 'volume detach **', class: WRITE },
      { match: 'volume list **', class: READ },
      { match: 'domain **', class: WRITE, note: 'adds a domain' },
      { match: 'add **', class: WRITE, note: 'adds a service or a database' },
      { match: 'init **', class: WRITE, note: 'creates a project' },
      { match: 'connect **', class: WRITE, note: 'a database shell can do anything' },
      { match: 'ssh **', class: WRITE, note: 'a shell inside the deployed service' },
      {
        match: 'run **',
        class: WRITE,
        tags: [SECRETS],
        note: 'runs a local command with the environment variables',
      },
      {
        match: 'shell **',
        class: WRITE,
        tags: [SECRETS],
        note: 'a local shell with the environment variables',
      },
      { match: 'link **', class: WRITE, note: 'local' },
      { match: 'unlink **', class: WRITE, note: 'local' },
      { match: 'service **', class: WRITE, note: 'local' },
      { match: 'environment **', class: WRITE, note: 'local' },
      { match: 'logs **', class: READ },
      { match: 'status **', class: READ },
      { match: 'list **', class: READ },
      { match: 'whoami **', class: READ },
      { match: 'open **', class: READ },
      { match: 'docs **', class: READ },
      { match: 'version **', class: READ },
      { match: 'help **', class: READ },
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
];
