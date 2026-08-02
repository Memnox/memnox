import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { Command } from 'commander';
import { AGENT_KIND } from '@memnox/core';
import { DEFAULT_HOST, DEFAULT_PORT, startServer } from '@memnox/runtime';
import { agentConfigPath, readAgentConfig, writeAgentConfig } from '../agent-config';
import type { CliContext } from '../cli-context';
import { DEFAULT_POLICY_FILE } from '../defaults';
import { EditorHookInstaller } from '../editor-hook-installer';
import { parseEnforcement } from '../enforcement-args';
import { policyRegistryPath, registerPolicyFile } from '../policy-registry';
import {
  composePolicyDocument,
  ensurePolicyFile,
  hookCommandFor,
} from '../project-setup';
import { detectStack } from '../stack-detection';
import type { ServerLauncher } from './serve.command';

/** A first run observes; a wrong rule must not wedge someone's editor on minute one. */
const FIRST_RUN_ENFORCEMENT = 'monitor';
/** One machine-local identity shared by every editor hook on this machine. */
const LOCAL_AGENT_NAME = 'local-editor';
/** Cheap, always-present route; an auth challenge still proves something is listening. */
const PROBE_PATH = '/v1/policies';
const PROBE_TIMEOUT_MS = 1500;

/** Whether a runtime already answers at this URL. Injected so tests never open a socket. */
type ServerProbe = (url: string) => Promise<boolean>;

const probeRuntime: ServerProbe = async (url) => {
  try {
    await fetch(`${url}${PROBE_PATH}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return true; // Any answer — including 401 — means the port is serving Memnox.
  } catch {
    return false; // Connection refused or timeout: nothing is there, so we start one.
  }
};

/**
 * `npx memnox setup` — nothing to a governed editor in one command: starter
 * policies, a registered agent whose token lands where the hook can read it,
 * editor hooks, and a running runtime.
 *
 * One runtime serves every project on the machine. Run this in a second
 * repository and it joins the runtime already listening rather than fighting it
 * for the port — which is what makes a frontend and a backend of one project
 * work.
 */
export function registerSetupCommand(
  program: Command,
  context: CliContext,
  installer = new EditorHookInstaller(homedir(), hookCommandFor),
  launch: ServerLauncher = startServer,
  homeDir: string = homedir(),
  probe: ServerProbe = probeRuntime,
): void {
  program
    .command('setup')
    .description('Policies, editor hooks, and a running runtime — in one command')
    .option('-f, --file <path>', 'policy file path', DEFAULT_POLICY_FILE)
    .option('-p, --port <port>', 'port to listen on', String(DEFAULT_PORT))
    .option('-H, --host <host>', 'host to bind', DEFAULT_HOST)
    .option(
      '--project <name>',
      'governance unit this repository belongs to; repos sharing a name share one scope',
    )
    .option('--no-hook', 'skip installing editor hooks')
    .option('--no-serve', 'scaffold policies and hooks without starting the runtime')
    .option('--enforce', 'block from the first request instead of observing first')
    .option(
      '--no-detect',
      'scaffold the generic starter rules instead of detecting the stack',
    )
    .action(
      async (options: {
        file: string;
        port: string;
        host: string;
        project?: string;
        hook: boolean;
        serve: boolean;
        detect: boolean;
        enforce?: boolean;
      }) => {
        const out = context.out;
        const detected = options.detect
          ? detectStack(dirname(resolve(options.file)))
          : null;
        await ensurePolicyFile(options.file, out, {
          project: options.project,
          content:
            detected === null
              ? undefined
              : composePolicyDocument(options.project, detected.packs),
        });
        if (detected !== null && detected.signals.length > 0) {
          out.line(`Detected: ${detected.signals.join(', ')}`);
          out.line(`Packs: ${detected.packs.join(', ')}`);
        }

        if (!options.serve) {
          if (options.hook) await installHooks(installer, out);
          out.line('');
          out.line(`memnox serve --policies ${options.file}`);
          out.note('');
          out.note('Then run "memnox setup" again to register the editor agent.');
          return;
        }

        const enforcing = options.enforce === true;
        const requested = `http://${options.host}:${options.port}`;
        const joined = await probe(requested);

        // Registered before either branch: whichever runtime ends up serving,
        // this repository's rules are one of its sources.
        const sources = await registerPolicyFile(homeDir, options.file);

        let url = requested;
        if (!joined) {
          const server = await launch({
            port: Number(options.port),
            host: options.host,
            policyFile: options.file,
            policyRegistryFile: policyRegistryPath(homeDir),
            enforcement: enforcing ? undefined : parseEnforcement(FIRST_RUN_ENFORCEMENT),
          });
          url = `http://${server.config.host}:${server.config.port}`;
        }

        const credentialed = await ensureAgentToken(context, homeDir, url);
        const reloaded = joined ? await reloadRunningRuntime(context, url) : false;
        const installedAny = options.hook ? await installHooks(installer, out) : false;

        out.line('');
        if (joined) {
          out.line(`Using the runtime already on ${url}`);
        } else {
          out.line(`Memnox runtime listening on ${url}`);
          out.line(`Policies: ${options.file}`);
          out.line(
            enforcing
              ? 'Enforcing — blocking decisions take effect now.'
              : 'Observing only — decisions are recorded, nothing is blocked yet.',
          );
        }
        if (options.project !== undefined) {
          out.line(`Project: ${options.project}`);
        }
        if (sources.length > 1) {
          out.line(`Rule sources: ${sources.length} files`);
        }

        out.note('');
        if (installedAny) out.note('→ Restart your editor to activate the hook.');
        if (!credentialed) {
          out.note('→ Editor hooks stay inactive until an agent token is stored.');
        }
        if (joined && !reloaded) {
          out.note('→ Its rules did not reload; restart it to pick up this repository.');
        }
        if (joined && enforcing) {
          // We did not start it, so we cannot change the mode it is running in.
          out.note('→ The running runtime keeps its mode; restart it to enforce.');
        }
        out.note('→ See what it decided:  memnox audit');
        if (!joined && !enforcing) {
          out.note('→ Start blocking:       memnox setup --enforce');
        }
      },
    );
}

/**
 * A runtime we joined was started before this repository existed, so it has to
 * be told to re-read its sources. Only paths reached it — the rules themselves
 * stay in the file this repository owns.
 */
async function reloadRunningRuntime(context: CliContext, url: string): Promise<boolean> {
  try {
    await context.client({ url }).reloadPolicies();
    return true;
  } catch (err) {
    // Not fatal: the rules are registered and load on the runtime's next start.
    context.out.note(`Could not reload the running runtime: ${String(err)}`);
    return false;
  }
}

/** Returns whether any hook was newly written, so the caller knows to ask for a restart. */
async function installHooks(
  installer: EditorHookInstaller,
  out: CliContext['out'],
): Promise<boolean> {
  const reports = await installer.installDetected();
  if (reports.length === 0) {
    out.note('No Claude Code or Cursor config found — skipping editor hooks.');
    return false;
  }
  let installedAny = false;
  for (const report of reports) {
    if (report.installed) installedAny = true;
    out.line(
      report.installed
        ? `Installed the ${report.agent} hook`
        : `The ${report.agent} hook was already installed`,
    );
  }
  return installedAny;
}

/**
 * Registers the machine-local agent once and stores its token. Reuses an
 * existing token rather than minting a second identity on every run — the
 * audit trail should show one editor, not one per invocation.
 */
async function ensureAgentToken(
  context: CliContext,
  homeDir: string,
  url: string,
): Promise<boolean> {
  const stored = await readAgentConfig(homeDir);
  if (stored.token !== undefined) {
    // The port may have moved since the token was issued; keep the URL current.
    if (stored.url !== url) await writeAgentConfig(homeDir, { ...stored, url });
    context.out.note(`Using the agent token already at ${agentConfigPath(homeDir)}`);
    return true;
  }

  try {
    const client = context.client({ url });
    const registration = await client.registerAgent(LOCAL_AGENT_NAME, AGENT_KIND.CUSTOM);
    const path = await writeAgentConfig(homeDir, { token: registration.token, url });
    context.out.line(
      `Registered agent "${registration.agent.name}" — token saved to ${path}`,
    );
    return true;
  } catch (err) {
    // Setup must not die here: the runtime is already up and still usable by hand.
    context.out.note(`Could not register the editor agent: ${String(err)}`);
    context.out.note('Register it yourself: memnox agents register --name local-editor');
    return false;
  }
}
