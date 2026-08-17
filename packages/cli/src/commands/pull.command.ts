import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import type { Policy } from '@memnox/policy-engine';
import { readAgentConfig, type AgentConfig } from '../agent-config';
import type { CliContext } from '../cli-context';
import { CloudClient } from '../cloud-client';
import {
  isNotConfigured,
  resolveCloud,
  SIGN_IN_HINT,
  WORKSPACE_HINT,
  type CloudResolution,
} from '../cloud-connection';
import { describeConnectionFailure, resolveConnection } from '../connection';
import { writeOrgPolicies } from '../org-policy-source';
import { policyRegistryPath, registerPolicyFile } from '../policy-registry';
import type { CloudClientFactory } from './login.command';

const buildCloudClient: CloudClientFactory = (connection) => new CloudClient(connection);

const EXIT_UNAVAILABLE = 1;

/**
 * Brings the organization's rules onto this machine.
 *
 * The laptop dials out, which is what makes this work at all: a control plane
 * cannot reach a developer's machine, so distribution has to be a pull. The
 * rules land in their own source file registered alongside the repository's,
 * and the engine composes both — most-restrictive-wins, so a pull can only
 * ever tighten what this machine already enforced.
 */
export function registerPullCommand(
  program: Command,
  context: CliContext,
  homeDir: string = homedir(),
  buildClient: CloudClientFactory = buildCloudClient,
): void {
  program
    .command('pull')
    .description("Fetch your organization's rules and apply them to this machine")
    .option('--cloud <url>', 'control plane base URL')
    .option('--token <token>', 'control plane API token')
    .option('--workspace <id>', 'workspace to pull')
    .option('--admin-token <token>', 'admin token, if the local runtime requires one')
    .option('--no-reload', 'write the rules without asking the runtime to re-read them')
    .action(
      async (options: {
        cloud?: string;
        token?: string;
        workspace?: string;
        adminToken?: string;
        reload: boolean;
      }) => {
        const stored = await readAgentConfig(homeDir);
        const resolution: CloudResolution = resolveCloud(
          {
            cloudUrl: options.cloud,
            cloudToken: options.token,
            workspace: options.workspace,
          },
          stored,
          process.env,
        );
        if (isNotConfigured(resolution)) {
          context.out.line(SIGN_IN_HINT);
          process.exitCode = EXIT_UNAVAILABLE;
          return;
        }
        const workspace = resolution.workspace;
        if (workspace === undefined) {
          context.out.line(WORKSPACE_HINT);
          process.exitCode = EXIT_UNAVAILABLE;
          return;
        }

        const bundle = await buildClient(resolution).bundle(workspace);
        const path = await writeOrgPolicies(
          homeDir,
          workspace,
          bundle.policies as Policy[],
        );
        const sources = await registerPolicyFile(homeDir, path);

        context.out.line(`Workspace: ${workspace}`);
        context.out.line(`Rules    : ${bundle.policyCount} (version ${bundle.version})`);
        if (bundle.packs.length > 0) {
          context.out.line(`From     : ${bundle.packs.join(', ')}`);
        }
        for (const name of bundle.policyNames) context.out.line(`  - ${name}`);
        context.out.line(`Written  : ${path}`);
        if (sources.length > 1) {
          context.out.note(`${sources.length} rule sources now load on this machine.`);
        }

        if (options.reload) {
          await reloadRuntime(context, stored, options.adminToken, path, homeDir);
        }
      },
    );
}

/**
 * A pulled rule set the runtime has not re-read is not yet in force, so silence
 * here would be a lie. Never fatal: the file is written either way, and a
 * developer with no runtime running still gets the rules on their next start.
 */
async function reloadRuntime(
  context: CliContext,
  stored: AgentConfig,
  adminToken: string | undefined,
  path: string,
  homeDir: string,
): Promise<void> {
  const flags = adminToken === undefined ? {} : { adminToken };
  const connection = resolveConnection(flags, stored, process.env);
  try {
    const { client } = await context.connect(flags);
    const result = await client.reloadPolicies();
    // Reloading is not the same as reading this file. A runtime started without
    // --policy-registry re-reads only what it was pointed at, and reported a
    // perfectly successful reload of everything except the rules just pulled.
    // A runtime too old to list its sources cannot be interrogated, so it gets
    // the benefit of the doubt rather than a warning nobody can act on.
    const read = result.sources ?? [];
    if (read.length > 0 && !read.includes(resolve(path))) {
      context.out.line(
        `Runtime  : reloaded, but ${connection.url} does not read this file, so these rules are not in force`,
      );
      context.out.note('');
      context.out.note(
        `Start it with the registry:  memnox serve --policy-registry ${policyRegistryPath(homeDir)}`,
      );
      return;
    }
    context.out.line(`Runtime  : reloaded — now enforcing version ${result.version}`);
    return;
  } catch (err) {
    // Not a footnote: the rules are on disk and nothing is enforcing them yet.
    // Which of the two reasons it is decides what the developer does next, so
    // never collapse "nothing is listening" into "it refused me".
    const unreachable = describeConnectionFailure(err, connection.url);
    context.out.line(
      unreachable === null
        ? `Runtime  : did not reload — ${connection.url} refused the request, so these rules are not in force yet`
        : `Runtime  : did not reload — ${connection.url} is not answering, so these rules are not in force yet`,
    );
    context.out.note(
      unreachable === null
        ? `Reloading is an admin action. Retry with --admin-token, or run "memnox reload". Rules are at ${path}.`
        : `Start the runtime, or run "memnox reload". Rules are at ${path}.`,
    );
  }
}
