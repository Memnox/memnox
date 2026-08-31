import type { ActionRequest } from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';
import type { HookAuthorizer } from './hook-authorizer';

export const GIT_CREDENTIAL_ACTION = 'git.credential';

/**
 * The seam that always exists. An agent that cannot be wrapped can still be starved:
 * this one never supplies a credential — it only declines to let the next helper do so.
 */
export const GIT_BLIND_SPOTS: readonly string[] = [
  'a credential already cached by another helper',
  'anything git does once a credential is handed over',
  'a remote reached without git, such as a raw HTTPS fetch',
];

export interface GitCredentialRequest {
  protocol?: string;
  host?: string;
  path?: string;
  username?: string;
}

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
        message: `could not rule on ${where} — the runtime is unreachable, so git was left alone. A withheld remote is reachable until it is back.`,
      };
    }
    return {
      stdout: QUIT,
      message: `no credential for ${where}: ${verdict.reason}`,
    };
  }
}

/** git writes one `key=value` per line, terminated by a blank line. */
export function parseGitInput(input: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of input.split('\n')) {
    if (line.length === 0) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    // Whatever git says about a password stays out of what we carry.
    if (key === 'password' || key === 'credential') continue;
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
