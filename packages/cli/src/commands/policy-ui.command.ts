import { randomBytes } from 'node:crypto';
import type { Command } from 'commander';
import { DECISION_EFFECT, type DecisionEffect } from '@memnox/core';
import {
  comparePolicySets,
  POLICY_DOCUMENT_VERSION,
  PolicyEngine,
  type Policy,
  type PolicyDocument,
} from '@memnox/policy-engine';
import { readPolicyDocumentFile, writePolicyDocumentFile } from '@memnox/local-gate';
import type { CliContext } from '../cli-context';
import { systemBrowser, type BrowserOpener } from '../browser-login';
import { DEFAULT_BASE_URL, DEFAULT_POLICY_FILE } from '../defaults';
import { casesFromAudit } from '../simulation-cases';
import { createPolicyUiHandler, type SimulationReport } from '../policy-ui/policy-ui-app';
import { loopbackPolicyUi, type PolicyUiLauncher } from '../policy-ui/policy-ui-server';
import {
  DEFAULT_POLICY_UI_PORT,
  SIMULATION_SAMPLE,
  UI_SESSION_TOKEN_BYTES,
} from '../policy-ui/policy-ui.constants';

/** Everything the editor needs from outside the process. Replaced wholesale in tests. */
export interface PolicyUiHost {
  launch: PolicyUiLauncher;
  open: BrowserOpener;
  sessionToken(): string;
}

const systemPolicyUiHost: PolicyUiHost = {
  launch: loopbackPolicyUi,
  open: systemBrowser,
  sessionToken: () => randomBytes(UI_SESSION_TOKEN_BYTES).toString('base64url'),
};

interface PolicyUiOptions {
  file: string;
  port: string;
  open: boolean;
  url?: string;
  token?: string;
  adminToken?: string;
  limit: string;
  defaultEffect: string;
}

const emptyDocument = (): PolicyDocument => ({
  version: POLICY_DOCUMENT_VERSION,
  policies: [],
});

/**
 * The rule editor most developers actually want: the same file, the same
 * validator and the same simulation, behind a form instead of YAML. It writes
 * the policy file and nothing else, so every rule made here still arrives in a
 * diff a reviewer can read.
 */
export function registerPolicyUiCommand(
  parent: Command,
  context: CliContext,
  host: PolicyUiHost = systemPolicyUiHost,
): void {
  parent
    .command('ui')
    .description('Edit policies in a local browser UI instead of the YAML file')
    .option('-f, --file <path>', 'policy file', DEFAULT_POLICY_FILE)
    .option(
      '-p, --port <port>',
      'loopback port to serve on',
      String(DEFAULT_POLICY_UI_PORT),
    )
    .option('--no-open', 'print the URL instead of opening a browser')
    .option(
      '--url <url>',
      `runtime base URL for the simulate panel (default: ${DEFAULT_BASE_URL})`,
    )
    .option('--admin-token <token>', 'admin token for reading audit history')
    .option(
      '--limit <n>',
      'audit events the simulate panel replays',
      String(SIMULATION_SAMPLE),
    )
    .option(
      '--default-effect <effect>',
      'effect when no policy matches, for the simulate panel',
      DECISION_EFFECT.ALLOW,
    )
    .action(async (options: PolicyUiOptions) => {
      const read = async (): Promise<PolicyDocument> =>
        (await readPolicyDocumentFile(options.file)) ?? emptyDocument();

      const handle = createPolicyUiHandler({
        filePath: options.file,
        sessionToken: host.sessionToken(),
        read,
        write: async (document) => writePolicyDocumentFile(options.file, document),
        simulate: async (candidate) => replayHistory(context, options, read, candidate),
        onError: (message) => context.out.note(`policy editor: ${message}`),
      });

      const session = await host.launch(handle, Number(options.port));
      context.out.line(session.url);
      context.out.note(`Editing ${options.file} — loopback only, this machine alone.`);
      context.out.note(
        'Saving rewrites the file from the rules in the editor; comments in it are not carried over.',
      );
      context.out.note('Press Ctrl-C to stop.');

      if (options.open) await host.open(session.url);
      await session.finished;
    });
}

/**
 * What the candidate rules would have decided about the actions that really
 * happened. Unreachable runtime is the ordinary case for someone editing rules
 * before they have run anything, so it reports why rather than failing.
 */
async function replayHistory(
  context: CliContext,
  options: PolicyUiOptions,
  read: () => Promise<PolicyDocument>,
  candidate: readonly Policy[],
): Promise<SimulationReport> {
  const { client, connection } = await context.connect(options);

  let cases;
  try {
    cases = casesFromAudit(await client.recentAudit(Number(options.limit)));
  } catch (err) {
    context.out.note(
      `policy editor: could not read audit history from ${connection.url} — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {
      available: false,
      reason: `No runtime answering at ${connection.url}. Start one with "memnox serve" to replay real history.`,
    };
  }

  if (cases.length === 0) {
    return {
      available: false,
      reason: 'No audit history yet — let the runtime observe some actions first.',
    };
  }

  const defaultEffect = options.defaultEffect as DecisionEffect;
  const inForce = (await read()).policies;
  return {
    available: true,
    ...comparePolicySets(
      new PolicyEngine(inForce, { defaultEffect }),
      new PolicyEngine([...candidate], { defaultEffect }),
      cases,
    ),
  };
}
