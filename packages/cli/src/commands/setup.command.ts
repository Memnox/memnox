import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { Command } from 'commander';
import { AGENT_KIND, DECISION_REASON, ENFORCEMENT_MODE } from '@memnox/core';
import { DEFAULT_HOST, DEFAULT_PORT } from '@memnox/runtime';
import { createDetachedLauncher, daemonPaths, readDaemonPid } from '../runtime-daemon';
import { agentConfigPath, readAgentConfig, writeAgentConfig } from '../agent-config';
import type { CliContext } from '../cli-context';
import { DEFAULT_POLICY_FILE } from '../defaults';
import { McpInstaller } from '../mcp-installer';
import { parseEnforcement } from '../enforcement-args';
import { policyRegistryPath, registerPolicyFile } from '../policy-registry';
import { composePolicyDocument, ensurePolicyFile } from '../project-setup';
import { detectStack } from '../stack-detection';
import type { ServerLauncher } from './serve.command';

/** A first run observes; a wrong rule must not wedge someone's agent on minute one. */
const FIRST_RUN_ENFORCEMENT = 'monitor';

/**
 * Every deterministic guard, on, for a local install.
 *
 * Safe precisely because the first run observes: a guard that fires is a line in
 * the audit trail, not a blocked agent, so someone can read what it caught
 * before deciding to enforce. `memnox serve` keeps its explicit-flag contract —
 * a server deployment should not silently gain three audit queries per request
 * because a default moved.
 */
const LOCAL_GUARDS = {
  behaviorGuard: true,
  trustGuard: true,
  verificationGuard: true,
} as const;

/** Named so the report and the flag description cannot drift apart. */
const GUARD_SUMMARY =
  'shell indirection, taint, decision memory, behavior, trust, verification';
/** One machine-local identity shared by every local agent on this machine. */
const LOCAL_AGENT_NAME = 'local-editor';
/**
 * Verifying the stored token asks what a benign action would be judged as, which
 * records nothing and raises no approval — the one identity check that does not
 * pollute the audit trail on every run.
 */
const TOKEN_PROBE_ACTION = 'memnox.identity.verify';

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
 * `npx memnox setup` — nothing to a governed agent in one command: starter
 * policies, a registered agent whose token lands where local tooling can read
 * it, and a running runtime.
 *
 * One runtime serves every project on the machine. Run this in a second
 * repository and it joins the runtime already listening rather than fighting it
 * for the port — which is what makes a frontend and a backend of one project
 * work.
 */
export function registerSetupCommand(
  program: Command,
  context: CliContext,
  launch: ServerLauncher = createDetachedLauncher(homedir()),
  homeDir: string = homedir(),
  probe: ServerProbe = probeRuntime,
  mcpInstaller = new McpInstaller(homedir()),
): void {
  program
    .command('setup')
    .description('Policies, an agent identity, and a running runtime — in one command')
    .option('-f, --file <path>', 'policy file path', DEFAULT_POLICY_FILE)
    .option('-p, --port <port>', 'port to listen on', String(DEFAULT_PORT))
    .option('-H, --host <host>', 'host to bind', DEFAULT_HOST)
    .option(
      '--project <name>',
      'governance unit this repository belongs to; repos sharing a name share one scope',
    )
    .option('--no-mcp', 'skip registering the Memnox MCP server with your agent')
    .option('--no-serve', 'scaffold policies without starting the runtime')
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
        mcp: boolean;
        serve: boolean;
        detect: boolean;
        enforce?: boolean;
      }) => {
        const out = context.out;
        const style = context.style;
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
          if (options.mcp) await installMcp(mcpInstaller, out);
          out.line('');
          out.line(`memnox serve --policies ${options.file}`);
          out.note('');
          out.note('Then run "memnox setup" again to register the local agent.');
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
            ...LOCAL_GUARDS,
          });
          url = `http://${server.config.host}:${server.config.port}`;
        }

        const credentialed = await ensureAgentToken(context, homeDir, url);
        const reloaded = joined ? await reloadRunningRuntime(context, url) : false;
        // A joined runtime used to be stuck in the mode it started in.
        const armed = joined && enforcing ? await enforceOnRunning(context, url) : false;
        const mcpAny = options.mcp ? await installMcp(mcpInstaller, out) : false;

        out.line('');
        if (joined) {
          out.line(`Using the runtime already on ${style.bold(url)}`);
        } else {
          out.line(`Memnox runtime listening on ${style.bold(url)}`);
          // The prompt comes back, so say where it went and how to end it.
          const paths = daemonPaths(homeDir);
          const pid = await readDaemonPid(paths);
          if (pid !== null) {
            out.line(`${style.dim('Running in the background:')} pid ${pid}`);
            out.line(`${style.dim('Logs:')} ${paths.logFile}`);
          }
          out.line(`${style.dim('Policies:')} ${options.file}`);
          out.line(
            enforcing
              ? style.ok('Enforcing — blocking decisions take effect now.')
              : style.warn(
                  'Observing only — decisions are recorded, nothing is blocked yet.',
                ),
          );
        }
        if (options.project !== undefined) {
          out.line(`${style.dim('Project:')} ${options.project}`);
        }
        if (sources.length > 1) {
          out.line(`${style.dim('Rule sources:')} ${sources.length} files`);
        }

        if (!joined) out.line(`${style.dim('Guards:')} ${GUARD_SUMMARY}`);

        out.note('');
        if (mcpAny) {
          out.note(style.bold('→ Restart your agent to activate it.'));
        }
        if (!credentialed) {
          out.note(
            style.warn(
              '→ Local governance stays inactive until an agent token is stored.',
            ),
          );
        }
        if (joined && !reloaded) {
          out.note(
            style.warn(
              '→ Its rules did not reload; restart it to pick up this repository.',
            ),
          );
        }
        if (joined && enforcing) {
          out.note(
            armed
              ? style.ok('→ Enforcing now — the running runtime took the change.')
              : style.warn(
                  '→ Could not change its mode; it needs an admin token, or restart it to enforce.',
                ),
          );
        }
        out.note(style.dim('→ See what it decided:  memnox audit'));
        if (!joined && !enforcing) {
          out.note(style.dim('→ Start blocking:       memnox setup --enforce'));
        }
        if (!joined) out.note(style.dim('→ Stop it:             memnox stop'));
      },
    );
}

/** Arms a runtime this command did not start, which used to need a restart. */
async function enforceOnRunning(context: CliContext, url: string): Promise<boolean> {
  try {
    await context.client({ url }).setEnforcement({ default: ENFORCEMENT_MODE.ENFORCE });
    return true;
  } catch {
    // Almost always an unauthenticated caller against a runtime with a token.
    return false;
  }
}

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

/**
 * Registers Memnox as an MCP server so the agent can ask what the rules are
 * before it acts. Without this the rules are installed but nothing ever asks
 * for them, which looks exactly like having no rules at all.
 */
async function installMcp(
  mcpInstaller: McpInstaller,
  out: CliContext['out'],
): Promise<boolean> {
  const reports = await mcpInstaller.installDetected();
  if (reports.length === 0) return false;

  let installedAny = false;
  for (const report of reports) {
    if (report.installed) installedAny = true;
    out.line(
      report.installed
        ? `Registered the Memnox MCP server with ${report.client}`
        : `${report.client} already has the Memnox MCP server`,
    );
  }
  return installedAny;
}

/**
 * Whether this runtime still recognises the stored token. A stored token used to
 * be trusted on sight, so a token issued by an earlier runtime — a different data
 * directory, a wiped `.memnox/` — reported "using the agent token already at …"
 * and then blocked every action as an unknown agent, with the CLI reporting success.
 */
async function tokenIsKnown(
  context: CliContext,
  url: string,
  token: string,
): Promise<boolean> {
  try {
    const assessment = await context
      .client({ url, token })
      .evaluateRisk({ action: TOKEN_PROBE_ACTION });
    return assessment.reason !== DECISION_REASON.UNKNOWN_AGENT;
  } catch (err) {
    // Unreachable or an unexpected shape: keep the token rather than churn
    // identities on a runtime that simply did not answer.
    context.out.note(`Could not verify the stored agent token: ${String(err)}`);
    return true;
  }
}

/**
 * Registers the machine-local agent once and stores its token. Reuses an
 * existing token rather than minting a second identity on every run — the
 * audit trail should show one local agent, not one per invocation.
 */
async function ensureAgentToken(
  context: CliContext,
  homeDir: string,
  url: string,
): Promise<boolean> {
  const stored = await readAgentConfig(homeDir);
  if (stored.token !== undefined && (await tokenIsKnown(context, url, stored.token))) {
    // The port may have moved since the token was issued; keep the URL current.
    if (stored.url !== url) await writeAgentConfig(homeDir, { ...stored, url });
    context.out.note(`Using the agent token already at ${agentConfigPath(homeDir)}`);
    return true;
  }
  if (stored.token !== undefined) {
    // A token minted against a previous runtime's identity store reports success
    // here and then blocks every action as an unknown agent.
    context.out.note(
      'The stored agent token is not known to this runtime — registering again.',
    );
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
    context.out.note(`Could not register the local agent: ${String(err)}`);
    context.out.note('Register it yourself: memnox agents register --name local-editor');
    return false;
  }
}
