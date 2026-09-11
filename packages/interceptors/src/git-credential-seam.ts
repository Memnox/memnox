import type { ActionRequest } from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';
import type { HookAuthorizer } from './hook-authorizer';

export const GIT_CREDENTIAL_ACTION = 'git.credential';

export interface GitCredentialOutcome {
  /**
   * What to write on stdout. Empty means "no opinion", and git asks the next helper;
   * `quit=1` stops it asking anyone. A credential is never among the things it can say.
   */
  stdout: string;
  message?: string;
}

/** Stops git asking any further helper, which is how a decline actually bites. */
const QUIT = 'quit=1\n';

export interface GitCredentialSeamDeps {
  authorizer: HookAuthorizer;
  sessionId?: string;
}

/**
 * Reads git's own key=value block, rules on the remote it names, and either stays
 * silent or declines. It holds no secrets and can hand none out, which is the only
 * shape of credential helper worth trusting inside a governance tool.
 */
export class GitCredentialSeam {
  constructor(private readonly deps: GitCredentialSeamDeps) {}

  async gate(input: string): Promise<GitCredentialOutcome> {
    const fields = parseGitInput(input);
    const target = remoteOf(fields);

    const request: ActionRequest = {
      action: GIT_CREDENTIAL_ACTION,
      ...(target === undefined ? {} : { target }),
      // LOCAL ONLY, and it never contains the credential — git has not issued one yet.
      arguments: { ...fields },
      ...(this.deps.sessionId === undefined ? {} : { sessionId: this.deps.sessionId }),
    };

    const verdict = await this.deps.authorizer.authorize(request);
    if (verdict.effect === DECISION_EFFECT.ALLOW) return { stdout: '' };

    const where = target === undefined ? 'this remote' : target;

    /* Deliberately open when nobody could be asked, and only here. This seam sits in
       front of every git operation a person performs, and it can only ever subtract:
       declining to rule leaves the machine exactly as it was before Memnox was
       installed, while `quit=1` breaks every clone and push on a network blip. What
       this gives up is real and is named: a frozen repository stays reachable for as
       long as the runtime is down. The hook and shell seams still fail closed. */
    if (verdict.unreachable === true) {
      return {
        stdout: '',
        message: `could not rule on ${where} — the runtime is unreachable, so git was left alone. A denied remote is reachable until it is back.`,
      };
    }
    return {
      stdout: QUIT,
      message: `no credential for ${where}: ${verdict.reason}`,
    };
  }
}

/**
 * The only fields carried out of git's block, and it is an allow list.
 *
 * These four are what `remoteOf` needs to name the remote, and a rule matches on
 * that name. Everything else git sends is dropped unread.
 *
 * An allow list rather than a deny list, and the difference is the guarantee.
 * Dropping `password` and `credential` by name was right for the protocol as it
 * stood and wrong as a shape: git's credential block is extensible and already
 * carries `oauth_refresh_token`, which is a long-lived secret under a key nobody
 * here had heard of. `arguments` reaches the ledger, so a deny list means every
 * field git adds in a future release is written to disk until somebody notices.
 * SECURITY.md puts "a credential value reaching a ledger row" in scope, and a
 * list of what is safe cannot fail that way.
 *
 * Today's caller only ever runs `get`, where git has issued nothing yet, so this
 * is the second line rather than the first. It is here because the first line is
 * one `if` in a different file.
 */
const CARRIED_FIELDS = ['protocol', 'host', 'path', 'username'] as const;

/** git writes one `key=value` per line, terminated by a blank line. */
export function parseGitInput(input: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of input.split('\n')) {
    if (line.length === 0) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!CARRIED_FIELDS.includes(key as (typeof CARRIED_FIELDS)[number])) continue;
    fields[key] = line.slice(separator + 1).trim();
  }
  return fields;
}

function remoteOf(fields: Readonly<Record<string, string>>): string | undefined {
  const host = fields['host'];
  if (host === undefined || host.length === 0) return undefined;
  const protocol = fields['protocol'] ?? 'https';
  const path = fields['path'];
  return `${protocol}://${host}${path === undefined ? '' : `/${path}`}`;
}
