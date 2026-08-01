import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { Command } from 'commander';
import { AGENT_KIND, ENFORCEMENT_MODE } from '@memnox/core';
import { DEFAULT_HOST, DEFAULT_PORT, startServer } from '@memnox/runtime';
import { agentConfigPath, readAgentConfig, writeAgentConfig } from '../agent-config';
import type { CliContext } from '../cli-context';
import { DEFAULT_POLICY_FILE } from '../defaults';
import { mkdir, writeFile } from 'node:fs/promises';
import { CodeGraph, graphifyToSnapshot, isGraphifyDocument } from '@memnox/code-graph';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GRAPHIFY_OUTPUT } from '../graphify-runner';
import { readRepoSources } from '../repo-walk';
import { DEFAULT_CODE_GRAPH_FILE } from '../defaults';
import { EditorHookInstaller } from '../editor-hook-installer';
import { McpInstaller } from '../mcp-installer';
import { parseEnforcement } from '../enforcement-args';
import { policyRegistryPath, registerPolicyFile } from '../policy-registry';
import {
  composePolicyDocument,
  ensurePolicyFile,
  hookCommandFor,
} from '../project-setup';
import { detectStack } from '../stack-detection';
import { detectProtectedPaths } from '../protected-paths';
import type { ServerLauncher } from './serve.command';

/** A first run observes; a wrong rule must not wedge someone's editor on minute one. */
const FIRST_RUN_ENFORCEMENT = 'monitor';

/**
 * Every deterministic guard, on, for a local install.
 *
 * Safe precisely because the first run observes: a guard that fires is a line in
 * the audit trail, not a blocked editor, so someone can read what it caught
 * before deciding to enforce. `memnox serve` keeps its explicit-flag contract —
 * a server deployment should not silently gain three audit queries per request
 * because a default moved.
 */
const LOCAL_GUARDS = {
  behaviorGuard: true,
  trustGuard: true,
  verificationGuard: true,
  dependencyGuard: true,
} as const;

/**
 * Blast radius needed two manual steps nobody took — `graph build`, then
 * `serve --code-graph`. A guard that requires homework is a guard nobody has.
 */
interface BuiltGraph {
  path: string;
  /** Reported so nobody has to guess which producer was used. */
  summary: string;
  /** Every graphed path, so protected patterns are derived from what is really here. */
  files: string[];
}

async function buildCodeGraph(
  root: string,
  out: string,
  output: CliContext['out'],
): Promise<BuiltGraph | null> {
  try {
    // A Graphify graph is tree-sitter across 36 languages; the walker below is
    // regex over a handful. Prefer the better one when the repository has it.
    const fromGraphify = await readGraphifySnapshot(root);
    if (fromGraphify !== null) {
      await writeSnapshot(out, fromGraphify.snapshot);
      return {
        path: out,
        summary: `${out} (Graphify — ${fromGraphify.snapshot.files.length} files, ${fromGraphify.edgeCount} edges)`,
        files: fromGraphify.snapshot.files,
      };
    }

    const sources = await readRepoSources(root);
    if (sources.length === 0) return null;
    const snapshot = CodeGraph.build(sources).toSnapshot();
    await writeSnapshot(out, snapshot);
    return {
      path: out,
      summary: `${out} (${sources.length} files)`,
      files: snapshot.files,
    };
  } catch (err) {
    // Never fatal: a repository we cannot walk still deserves a governed editor.
    output.note(`Could not build the code graph: ${String(err)}`);
    return null;
  }
}

async function writeSnapshot(path: string, snapshot: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(snapshot), 'utf8');
}

/** Null when Graphify has not been run here — the normal case. */
async function readGraphifySnapshot(
  root: string,
): Promise<ReturnType<typeof graphifyToSnapshot> | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(root, GRAPHIFY_OUTPUT), 'utf8'),
    );
    return isGraphifyDocument(parsed) ? graphifyToSnapshot(parsed) : null;
  } catch {
    return null; // Absent or unreadable; the built-in walker still runs.
  }
}

/** Named so the report and the flag description cannot drift apart. */
const GUARD_SUMMARY =
  'content shield, shell indirection, taint, decision memory, behavior, trust, verification, dependencies';
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
  mcpInstaller = new McpInstaller(homedir()),
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
    .option('--no-mcp', 'skip registering the Memnox MCP server with your agent')
    .option('--no-graph', 'skip building the code graph blast radius needs')
    .option('--no-serve', 'scaffold policies and hooks without starting the runtime')
    .option('--enforce', 'block from the first request instead of observing first')
    .option(
      '--no-detect',
      'scaffold the generic starter rules instead of detecting the stack',
    )
    .option(
      '--protected-path <pattern>',
      'escalate changes that reach this path (repeatable; overrides detection)',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .action(
      async (options: {
        file: string;
        port: string;
        host: string;
        project?: string;
        hook: boolean;
        mcp: boolean;
        graph: boolean;
        serve: boolean;
        detect: boolean;
        protectedPath: string[];
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
          if (options.hook) await installHooks(installer, out);
          if (options.mcp) await installMcp(mcpInstaller, out);
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

        const graph = options.graph
          ? await buildCodeGraph(
              dirname(resolve(options.file)),
              DEFAULT_CODE_GRAPH_FILE,
              out,
            )
          : null;

        // The advisor only registers when it is given paths, so a graph without
        // these is a guard that silently never fires.
        const protectedPaths =
          options.protectedPath.length > 0
            ? options.protectedPath
            : graph === null
              ? []
              : detectProtectedPaths(graph.files);

        let url = requested;
        if (!joined) {
          const server = await launch({
            port: Number(options.port),
            host: options.host,
            policyFile: options.file,
            policyRegistryFile: policyRegistryPath(homeDir),
            enforcement: enforcing ? undefined : parseEnforcement(FIRST_RUN_ENFORCEMENT),
            ...LOCAL_GUARDS,
            ...(graph === null ? {} : { codeGraphFile: graph.path }),
            ...(protectedPaths.length === 0 ? {} : { protectedPaths }),
          });
          url = `http://${server.config.host}:${server.config.port}`;
        }

        const credentialed = await ensureAgentToken(context, homeDir, url);
        const reloaded = joined ? await reloadRunningRuntime(context, url) : false;
        // A joined runtime used to be stuck in the mode it started in.
        const armed = joined && enforcing ? await enforceOnRunning(context, url) : false;
        const installedAny = options.hook ? await installHooks(installer, out) : false;
        const mcpAny = options.mcp ? await installMcp(mcpInstaller, out) : false;

        out.line('');
        if (joined) {
          out.line(`Using the runtime already on ${style.bold(url)}`);
        } else {
          out.line(`Memnox runtime listening on ${style.bold(url)}`);
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
        if (graph !== null) out.line(`${style.dim('Code graph:')} ${graph.summary}`);
        if (protectedPaths.length > 0) {
          out.line(
            `${style.dim('Blast radius:')} escalating changes that reach ${protectedPaths.join(', ')}`,
          );
        } else if (graph !== null) {
          // Say it plainly: the graph is built and the guard is still off.
          out.line(
            style.warn(
              'Blast radius: no protected paths found — name them with --protected-path to escalate on reach',
            ),
          );
        }

        out.note('');
        if (installedAny || mcpAny) {
          out.note(style.bold('→ Restart your editor to activate it.'));
        }
        if (!credentialed) {
          out.note(
            style.warn('→ Editor hooks stay inactive until an agent token is stored.'),
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
      },
    );
}

/**
 * A runtime we joined was started before this repository existed, so it has to
 * be told to re-read its sources. Only paths reached it — the rules themselves
 * stay in the file this repository owns.
 */
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
 * Registers Memnox as an MCP server so the agent can ask what the rules are
 * before it writes. Without this the security baseline is installed but nothing
 * ever asks for it, which looks exactly like having no baseline at all.
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
