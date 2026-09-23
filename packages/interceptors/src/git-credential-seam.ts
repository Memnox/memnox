import { DECISION_EFFECT, type ActionRequest } from '@memnox/core';

import type { HookAuthorizer } from './hook-authorizer';

/**
 * git asking for a credential, which is the moment before it reaches a remote. It holds
 * no secret and can hand none out, which is the only credential helper worth trusting.
 */

export const GIT_CREDENTIAL_ACTION = 'git.credential';

export interface GitCredentialOutcome {
  /**
   * Empty means "no opinion", so git asks the
   * next helper; `quit=1` stops it asking anyone.
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
 * The only fields carried out of git's block, as an allow list: the block is extensible,
 * already carries `oauth_refresh_token`, and `arguments` reaches the ledger.
 */
const CARRIED_FIELDS: readonly string[] = ['protocol', 'host', 'path', 'username'];

/**
 * Reads git's own key=value block, rules on the
 * remote it names, and stays silent or declines.
 */
export class GitCredentialSeam {
  constructor(private readonly deps: GitCredentialSeamDeps) {}

  async gate(input: string): Promise<GitCredentialOutcome> {
    const fields = parseGitInput(input);
    const target = remoteOf(fields);

    const request: ActionRequest = {
      action: GIT_CREDENTIAL_ACTION,
      ...(target === undefined ? {} : { target }),
      // LOCAL ONLY, and it never contains the
      // credential, because git has not issued one yet.
      arguments: { ...fields },
      ...(this.deps.sessionId === undefined ? {} : { sessionId: this.deps.sessionId }),
    };

    const verdict = await this.deps.authorizer.authorize(request);
    if (verdict.effect === DECISION_EFFECT.ALLOW) return { stdout: '' };

    const where = target === undefined ? 'this remote' : target;
    return { stdout: QUIT, message: `no credential for ${where}: ${verdict.reason}` };
  }
}

/** git writes one `key=value` per line, terminated by a blank line. */
export function parseGitInput(input: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of input.split('\n')) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!CARRIED_FIELDS.includes(key)) continue;
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
