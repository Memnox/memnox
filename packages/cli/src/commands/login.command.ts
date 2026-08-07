import { homedir, hostname } from 'node:os';
import type { Command } from 'commander';
import { readAgentConfig, writeAgentConfig } from '../agent-config';
import type { CliContext } from '../cli-context';
import { CloudClient } from '../cloud-client';
import {
  isNotConfigured,
  resolveCloud,
  SIGN_IN_HINT,
  ENV_CLOUD_URL,
  type CloudFlags,
  type ResolvedCloud,
} from '../cloud-connection';
import { DEFAULT_BASE_URL, DEFAULT_CLOUD_URL } from '../defaults';
import {
  loginThroughBrowser,
  systemBrowser,
  timedOut,
  type BrowserOpener,
} from '../browser-login';
import { exchangeCliCode } from '../cloud-client';
import type { AgentConfig } from '../agent-config';

/** How a cloud-backed command obtains its client. Injected so tests never reach a network. */
export type CloudClientFactory = (connection: ResolvedCloud) => CloudClient;

const buildCloudClient: CloudClientFactory = (connection) => new CloudClient(connection);

const EXIT_NOT_SIGNED_IN = 1;

/**
 * Joins a developer's machine to their organization's control plane.
 *
 * Outbound only, and that is the point: the laptop dials the control plane, so
 * nothing has to reach *in* to a developer's machine. It is also why this is a
 * separate credential from the agent token — this one is the person, and an
 * editor hook must never be able to read the organization with it.
 */
export function registerLoginCommand(
  program: Command,
  context: CliContext,
  homeDir: string = homedir(),
  buildClient: CloudClientFactory = buildCloudClient,
  open: BrowserOpener = systemBrowser,
  exchange: CodeExchange = exchangeCliCode,
): void {
  program
    .command('login')
    .description('Sign this machine in to your organization control plane')
    .option('--cloud <url>', `control plane base URL (default: ${DEFAULT_CLOUD_URL})`)
    .option('--token <token>', 'skip the browser and use a token you already hold')
    .option('--workspace <id>', 'default workspace for cloud commands')
    .action(async (options: { cloud?: string; token?: string; workspace?: string }) => {
      const stored = await readAgentConfig(homeDir);
      const cloudUrl = resolveCloudUrl(options.cloud, stored, process.env);

      // No token to paste: open a browser, let a human sign in against the
      // session the control plane already trusts, and take the code back on a
      // loopback port. Nothing lands in shell history.
      const token =
        options.token ?? (await signInThroughBrowser(context, cloudUrl, exchange, open));
      if (token === null) {
        process.exitCode = EXIT_NOT_SIGNED_IN;
        return;
      }

      const resolution = resolveCloud(
        { cloudUrl, cloudToken: token, workspace: options.workspace },
        stored,
        process.env,
      );
      if (isNotConfigured(resolution)) {
        context.out.line(`Could not sign in to ${cloudUrl}.`);
        process.exitCode = EXIT_NOT_SIGNED_IN;
        return;
      }

      // Verified before it is stored: a credential that reaches nothing should
      // fail here, not later as every org command reporting unauthorized.
      const identity = await buildClient(resolution).me();

      const path = await writeAgentConfig(homeDir, {
        ...stored,
        cloud: {
          url: resolution.url,
          token: resolution.token,
          ...(resolution.workspace === undefined
            ? {}
            : { workspace: resolution.workspace }),
        },
      });

      context.out.line(`Signed in to ${resolution.url}`);
      if (identity.name !== undefined) {
        context.out.line(`You      : ${identity.name}${roleSuffix(identity.role)}`);
      }
      if (resolution.workspace !== undefined) {
        context.out.line(`Workspace: ${resolution.workspace}`);
      }
      context.out.note(`Stored in ${path}`);
    });

  program
    .command('logout')
    .description('Forget the control plane credential on this machine')
    .action(async () => {
      const stored = await readAgentConfig(homeDir);
      if (stored.cloud === undefined) {
        context.out.line('Not signed in to a control plane.');
        return;
      }
      const { cloud: _removed, ...rest } = stored;
      await writeAgentConfig(homeDir, rest);
      // The runtime credential is untouched: signing out of the org must not
      // stop the editor hook governing this machine.
      context.out.line('Signed out. The local runtime credential is unchanged.');
    });

  program
    .command('whoami')
    .description('Which runtime and which organization this machine is talking to')
    .action(async () => {
      const stored = await readAgentConfig(homeDir);
      context.out.line(`Runtime  : ${stored.url ?? DEFAULT_BASE_URL}`);
      context.out.line(
        `Agent    : ${stored.token === undefined ? 'none — run "memnox setup"' : 'stored'}`,
      );

      const resolution = resolveCloud({}, stored, process.env);
      if (isNotConfigured(resolution)) {
        context.out.line('Org      : not signed in');
        context.out.note(SIGN_IN_HINT);
        return;
      }
      const identity = await buildClient(resolution).me();
      context.out.line(`Org      : ${resolution.url} (${resolution.tokenSource})`);
      if (identity.name !== undefined) {
        context.out.line(`You      : ${identity.name}${roleSuffix(identity.role)}`);
      }
      if (resolution.workspace !== undefined) {
        context.out.line(`Workspace: ${resolution.workspace}`);
      }
    });
}

function roleSuffix(role: string | undefined): string {
  return role === undefined ? '' : ` (${role})`;
}

/** How a code becomes a machine credential. Injected so tests reach no network. */
type CodeExchange = typeof exchangeCliCode;

/** Flag, then environment, then what a previous login stored, then the default. */
function resolveCloudUrl(
  flag: string | undefined,
  stored: AgentConfig,
  env: NodeJS.ProcessEnv,
): string {
  const chosen =
    flag ??
    env[ENV_CLOUD_URL] ??
    (stored.cloud === undefined ? undefined : stored.cloud.url) ??
    DEFAULT_CLOUD_URL;
  return chosen.endsWith('/') ? chosen.slice(0, -1) : chosen;
}

/** Null when nobody finished signing in — the caller reports it, not this. */
async function signInThroughBrowser(
  context: CliContext,
  cloudUrl: string,
  exchange: CodeExchange,
  open: BrowserOpener,
): Promise<string | null> {
  context.out.line(`Opening ${cloudUrl} in your browser to sign in…`);
  const outcome = await loginThroughBrowser({ cloudUrl, open });
  if (timedOut(outcome)) {
    context.out.line('Sign-in did not complete. Run "memnox login" again to retry.');
    return null;
  }
  // The label is what a person recognises when revoking this machine later.
  const grant = await exchange(cloudUrl, outcome.code, outcome.verifier, machineLabel());
  return grant.token;
}

function machineLabel(): string {
  return `${hostname()} (${process.platform})`;
}
