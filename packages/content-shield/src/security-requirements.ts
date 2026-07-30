import type { SecurityRequirement } from '@memnox/core';

/**
 * The security baseline Memnox ships, as a lookup table.
 *
 * Bumped whenever an entry changes, so a briefing can be reproduced later —
 * the same guarantee `SHIELD_RULESET_VERSION` gives a scan verdict.
 */
export const SECURITY_BASELINE_VERSION = '2026.08.2';

interface RequirementRule {
  /** Matched against the action, case-insensitively, as a prefix or exact verb. */
  actions?: readonly string[];
  /** Matched against the target path or command text. */
  target?: RegExp;
  requirements: readonly SecurityRequirement[];
}

const AUTH = /auth|session|login|signup|password|token|jwt|oauth|sso|mfa|otp/i;
const UPLOAD = /upload|attachment|multipart|file-?store|s3|blob/i;
const ENDPOINT = /route|controller|handler|endpoint|api\/|resolver|\/pages\/api\//i;
const QUERY = /query|repository|dao|model|prisma|knex|sequelize|sql/i;
const CRYPTO = /crypt|cipher|hash|sign|verify|key|secret|nonce|random/i;
const TEMPLATE = /render|template|html|dangerouslySetInnerHTML|innerHTML/i;
const SERIALIZE = /deserial|unmarshal|parse|yaml|pickle|xml/i;

/**
 * Ordered, most specific first. Every entry is a requirement for a *class of
 * work*, not a finding about code — Memnox states what a change of this kind
 * must satisfy, and never opines on a change someone already wrote.
 */
const RULES: readonly RequirementRule[] = [
  {
    actions: ['file.write', 'code.modify', 'code.delete'],
    target: AUTH,
    requirements: [
      {
        id: 'authn-verify-server-side',
        requirement:
          'Work out who the caller is on the server, on every request. Never trust a user id, role, or claim that arrived from the browser.',
        why: 'Anyone can call the endpoint directly and send whatever they like, so a check made in the browser is only a suggestion.',
      },
      {
        id: 'authz-check-per-object',
        requirement:
          'Check that this caller is allowed to touch this particular record — not only that they are signed in.',
        why: 'Otherwise someone signed in can change the id in the request and read another customer’s data.',
      },
      {
        id: 'session-cookie-flags',
        requirement:
          'Set session cookies HttpOnly, Secure, and SameSite, and issue a brand new session id whenever someone signs in or changes role.',
        why: 'A session id that survives sign-in still works for whoever planted it — and they are now signed in as that person.',
      },
      {
        id: 'credential-storage',
        requirement:
          'Store passwords with a deliberately slow, salted hash — argon2, scrypt, or bcrypt. Never a plain SHA or MD5.',
        why: 'Fast hashes can be cracked offline at billions of guesses a second once a dump leaks.',
      },
      {
        id: 'auth-timing',
        requirement:
          'Compare secrets and tokens with a constant-time comparison, and answer the same way whether the account exists or not.',
        why: 'A compare that stops at the first wrong byte, or an error that reads differently, tells an attacker how close a guess was.',
      },
    ],
  },
  {
    actions: ['file.write', 'code.modify'],
    target: UPLOAD,
    requirements: [
      {
        id: 'upload-validate-type',
        requirement:
          'Decide what a file really is by reading its first bytes, and accept only the types on a list you wrote.',
        why: 'The content type and the file extension are both chosen by whoever is uploading.',
      },
      {
        id: 'upload-neutralize-name',
        requirement:
          'Choose the stored filename yourself. Never build a path out of the name that was uploaded.',
        why: 'A name containing "../" writes the file somewhere else on the disk entirely.',
      },
      {
        id: 'upload-cap-size',
        requirement: 'Set a maximum file size and a timeout on the upload route.',
        why: 'With no limit, a few huge slow uploads take the service down — no exploit needed.',
      },
      {
        id: 'upload-serve-isolated',
        requirement:
          'Serve uploaded files from a different domain, with a content type that cannot execute.',
        why: 'A file served from your own domain runs as your site, so an uploaded page can read your users’ sessions.',
      },
    ],
  },
  {
    actions: ['file.write', 'code.modify'],
    target: ENDPOINT,
    requirements: [
      {
        id: 'endpoint-authz',
        requirement:
          'Say in so many words whether this route needs a signed-in caller, and which ones may use it. Do not let a framework default answer that.',
        why: 'A newly added route is the most common way an endpoint ends up open to the whole internet.',
      },
      {
        id: 'endpoint-validate-input',
        requirement:
          'Check every input against a schema as it arrives, and reject fields you were not expecting.',
        why: 'Unchecked input is how injection gets in, and one unexpected field can quietly set something like isAdmin.',
      },
      {
        id: 'endpoint-rate-limit',
        requirement: 'Rate-limit anything open to the public or expensive to run.',
        why: 'Without a limit the endpoint is free password guessing, and a free way to run up your bill.',
      },
      {
        id: 'endpoint-response-shape',
        requirement:
          'Return only the fields the caller needs. Do not hand back a whole database row by default.',
        why: 'Whole rows leak internal fields today, and leak every new one somebody adds later.',
      },
    ],
  },
  {
    actions: ['file.write', 'code.modify'],
    target: QUERY,
    requirements: [
      {
        id: 'sql-parameterize',
        requirement:
          'Use parameterized queries or the query builder. Never paste a value into a SQL string.',
        why: 'A pasted value can close the query and start a second one of the attacker’s choosing.',
      },
      {
        id: 'sql-scope-tenant',
        requirement:
          'Name the owner or the tenant in the WHERE clause of every single query.',
        why: 'A forgotten owner clause is the most common way one customer ends up seeing another’s data.',
      },
    ],
  },
  {
    actions: ['file.write', 'code.modify'],
    target: TEMPLATE,
    requirements: [
      {
        id: 'xss-escape-by-default',
        requirement:
          'Let the template engine escape what it prints. Never drop text from a user straight into HTML.',
        why: 'Text placed into a page unescaped can run as script — through attributes and links too, not just tags.',
      },
    ],
  },
  {
    actions: ['file.write', 'code.modify'],
    target: SERIALIZE,
    requirements: [
      {
        id: 'deserialize-safely',
        requirement:
          'Parse untrusted input with a safe loader and a schema. Never let the input decide which types get created.',
        why: 'A parser that builds whatever type it is told to turns a payload into code running on your server.',
      },
    ],
  },
  {
    actions: ['file.write', 'code.modify'],
    target: CRYPTO,
    requirements: [
      {
        id: 'crypto-use-primitives',
        requirement:
          'Use a well-reviewed library and an authenticated mode — AES-GCM, or libsodium. Never invent the scheme yourself.',
        why: 'Broken encryption still produces convincing-looking ciphertext, so it looks fine right up until someone attacks it.',
      },
      {
        id: 'crypto-random',
        requirement:
          'Generate keys, nonces, and tokens from a cryptographic random source.',
        why: 'Math.random() and anything seeded from the clock can be guessed, and a guessable token can be forged.',
      },
    ],
  },
  {
    actions: ['shell.execute'],
    requirements: [
      {
        id: 'shell-no-interpolation',
        requirement:
          'Hand the arguments to the process as a list. Never build a shell command by joining strings.',
        why: 'A quote or a semicolon inside one of those values lets the caller run a command of their own.',
      },
      {
        id: 'shell-least-privilege',
        requirement:
          'Run with the narrowest working directory and the fewest permissions that still work.',
        why: 'A command that needs one folder should not be able to reach the rest of the disk.',
      },
    ],
  },
  {
    actions: ['dependency.add', 'dependency.install'],
    requirements: [
      {
        id: 'dependency-pin',
        requirement:
          'Pin the exact version, and commit the lockfile change alongside it.',
        why: 'A version range lets a release published tomorrow change what ships, with no diff for anyone to read.',
      },
      {
        id: 'dependency-provenance',
        requirement:
          'Confirm this is the package you meant — right name, right publisher — and read its install scripts before you add it.',
        why: 'A lookalike name is a common attack, and an install script runs on every laptop and in CI.',
      },
    ],
  },
  {
    actions: ['data.export', 'database.export'],
    requirements: [
      {
        id: 'export-minimize',
        requirement:
          'Export the fewest columns and rows that actually answer the question.',
        why: 'An export is a copy that walks out from behind your access controls and your deletion rules.',
      },
      {
        id: 'export-no-direct-identifiers',
        requirement:
          'Remove or replace names, emails, and other direct identifiers, unless they are the point of the export.',
        why: 'Those identifiers are what turns a mislaid file into a reportable breach.',
      },
    ],
  },
  {
    actions: [
      'database.migrate',
      'database.delete',
      'database.drop',
      'database.truncate',
    ],
    requirements: [
      {
        id: 'migration-reversible',
        requirement:
          'Write the way back and test it, and keep destructive steps out of the deploy that ships the code.',
        why: 'A migration you cannot undo turns an ordinary bad deploy into lost data.',
      },
      {
        id: 'migration-backup-first',
        requirement:
          'Confirm a backup exists and has actually been restored somewhere before anything destructive runs.',
        why: 'A backup nobody has ever restored is not yet a backup.',
      },
    ],
  },
  {
    actions: ['deploy.'],
    requirements: [
      {
        id: 'deploy-secrets-from-store',
        requirement:
          'Read secrets from the secret store when the process starts. Never bake them into an image or a browser bundle.',
        why: 'Anything inside an image or a bundle can be read by anyone who can download it.',
      },
    ],
  },
];

/** Always applies: the rules that hold whatever the change touches. */
const UNIVERSAL: readonly SecurityRequirement[] = [
  {
    id: 'no-hardcoded-secrets',
    requirement:
      'Never write a password, key, or token into source. Read it from the environment or the secret store.',
    why: 'Deleting the line afterwards does not help — it stays in the git history, so the secret has to be replaced.',
  },
  {
    id: 'no-secrets-in-logs',
    requirement:
      'Keep passwords, tokens, and personal data out of logs and error messages.',
    why: 'Logs get copied to dashboards and inboxes that guard them far less carefully than the database does.',
  },
];

const ACTIONS_WITH_NO_SIDE_EFFECT: readonly string[] = ['file.read', 'repository.read'];

function matchesAction(rule: RequirementRule, action: string): boolean {
  if (rule.actions === undefined) return true;
  return rule.actions.some(
    (candidate) => action === candidate || action.startsWith(candidate),
  );
}

/**
 * The security baseline for a class of work, looked up deterministically.
 *
 * Same action and target always produce the same requirements, in the same
 * order — a briefing is cacheable and diffable, and a verdict can be explained
 * by pointing at the rule that produced it.
 */
export function securityRequirementsFor(
  action: string,
  target?: string,
): SecurityRequirement[] {
  const verb = action.toLowerCase();
  // A read changes nothing, so a list of write-time obligations is just noise.
  if (ACTIONS_WITH_NO_SIDE_EFFECT.includes(verb)) return [];

  const seen = new Set<string>();
  const requirements: SecurityRequirement[] = [];
  for (const rule of RULES) {
    if (!matchesAction(rule, verb)) continue;
    if (
      rule.target !== undefined &&
      (target === undefined || !rule.target.test(target))
    ) {
      continue;
    }
    for (const requirement of rule.requirements) {
      if (seen.has(requirement.id)) continue;
      seen.add(requirement.id);
      requirements.push(requirement);
    }
  }
  for (const requirement of UNIVERSAL) {
    if (seen.has(requirement.id)) continue;
    seen.add(requirement.id);
    requirements.push(requirement);
  }
  return requirements;
}
