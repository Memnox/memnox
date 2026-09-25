/** Databases and payments: where a command reads or moves somebody else's records. */
import { TOOL_CLASS } from '../../discovery/classify';
import { VERB_TAG, type VerbTable } from '../verb-table';

const READ = TOOL_CLASS.READ;
const WRITE = TOOL_CLASS.WRITE;
const GONE = TOOL_CLASS.DESTRUCTIVE;
const SENDS = TOOL_CLASS.COMMUNICATION;
const PROD = VERB_TAG.PRODUCTION;
const SECRETS = VERB_TAG.SECRETS;

export const DATA_TABLES: readonly VerbTable[] = [
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
    name: 'stripe',
    credential: ['~/.config/stripe/config.toml', 'STRIPE_API_KEY'],
    headline: 'can move money',
    globalFlags: [
      '--api-key',
      '--project-name',
      '-p',
      '--device-name',
      '--color',
      '--log-level',
      '--config',
    ],
    verbs: [
      { match: 'customers delete **', class: GONE },
      {
        match: 'refunds create **',
        class: WRITE,
        tags: [PROD],
        note: 'moves money',
        alternative: 'stripe charges retrieve, and let a person refund',
      },
      { match: 'charges create **', class: WRITE, tags: [PROD], note: 'moves money' },
      { match: 'charges capture **', class: WRITE, tags: [PROD], note: 'moves money' },
      {
        match: 'payment_intents create **',
        class: WRITE,
        tags: [PROD],
        note: 'moves money',
      },
      {
        match: 'payment_intents confirm **',
        class: WRITE,
        tags: [PROD],
        note: 'moves money',
      },
      {
        match: 'payment_intents capture **',
        class: WRITE,
        tags: [PROD],
        note: 'moves money',
      },
      { match: 'payouts create **', class: WRITE, tags: [PROD], note: 'moves money' },
      { match: 'transfers create **', class: WRITE, tags: [PROD], note: 'moves money' },
      { match: 'invoices pay **', class: WRITE, tags: [PROD], note: 'moves money' },
      { match: 'subscriptions cancel **', class: WRITE, tags: [PROD] },
      // The raw API: the method is the verb.
      { match: 'get **', class: READ },
      { match: 'post **', class: WRITE, alternative: 'stripe get, to read it' },
      { match: 'delete **', class: GONE, alternative: 'stripe get, to read it' },
      // Test-mode fixtures still create real objects in the account.
      { match: 'trigger **', class: WRITE, note: 'creates test objects' },
      { match: 'fixtures **', class: WRITE, note: 'creates test objects' },
      { match: 'events resend **', class: WRITE, note: 'redelivers a webhook' },
      { match: 'listen **', class: READ },
      { match: 'logs tail **', class: READ },
      { match: 'status **', class: READ },
      { match: 'version **', class: READ },
      { match: 'open **', class: READ },
      { match: 'config --list **', class: READ },
      { match: 'config **', class: WRITE, note: 'local' },
      { match: 'login **', class: WRITE, tags: [SECRETS] },
      { match: 'logout **', class: WRITE },
      { match: 'samples **', class: WRITE, note: 'local' },
      // `stripe <resource> <operation>`: the operation says what it does, whatever the resource.
      { match: '* list **', class: READ },
      { match: '* retrieve **', class: READ },
      { match: '* search **', class: READ },
      { match: '* upcoming **', class: READ },
      { match: '* list_line_items **', class: READ },
      { match: '* * list **', class: READ },
      { match: '* * retrieve **', class: READ },
      { match: '* delete **', class: GONE },
      { match: '* * delete **', class: GONE },
      { match: '* create **', class: WRITE },
      { match: '* update **', class: WRITE },
      { match: '* cancel **', class: WRITE },
      { match: '* capture **', class: WRITE, tags: [PROD], note: 'moves money' },
      { match: '* confirm **', class: WRITE, tags: [PROD], note: 'moves money' },
      { match: '* pay **', class: WRITE, tags: [PROD], note: 'moves money' },
      { match: '* void_invoice **', class: WRITE },
      { match: '* finalize_invoice **', class: WRITE },
      { match: '* send_invoice **', class: SENDS },
      { match: '* mark_uncollectible **', class: WRITE },
      { match: '* reverse **', class: WRITE, tags: [PROD], note: 'moves money' },
      { match: '* resume **', class: WRITE },
      { match: '* close **', class: WRITE },
      { match: '* expire **', class: WRITE },
      { match: '* verify **', class: WRITE },
      { match: '* attach **', class: WRITE },
      { match: '* detach **', class: WRITE },
      { match: '* * create **', class: WRITE },
      { match: '* * update **', class: WRITE },
    ],
  },
];
