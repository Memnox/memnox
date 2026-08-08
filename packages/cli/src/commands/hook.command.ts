import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import type { ActionRequest, Decision } from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';
import { CONTENT_METADATA_KEY, CONTENT_SCANNED_ACTIONS } from '@memnox/content-shield';
import { LocalGate, SECRET_RESPONSE, type LocalVerdict } from '@memnox/local-gate';
import {
  CURSOR_AFTER_FILE_EDIT,
  CURSOR_PERMISSION,
  mapCursorPayload,
  toCursorPermission,
  type CursorHookPayload,
  type CursorHookResponse,
} from '../cursor-hook-mapping';
import { readAgentConfig, type AgentConfig } from '../agent-config';
import { DEFAULT_BASE_URL } from '../defaults';
import { processHookHost, type HookHost } from '../hook-host';
import { findPolicyFile, resolveProjectId } from '../project-identity';
import {
  HOOK_EXIT_BLOCK,
  mapHookPayload,
  type ClaudeCodeHookPayload,
} from '../hook-mapping';
import { shieldDenialMessage } from '../write-shield';

/** Names the hook to rules that match on `agents:`. */
const HOOK_AGENT_NAME = 'editor-hook';
const ENV_AGENT_TOKEN = 'MEMNOX_AGENT_TOKEN';
const ENV_RUNTIME_URL = 'MEMNOX_URL';
/** "true" blocks tool calls when the runtime is unreachable. Default: fail open — a hook must never brick an editor. */
const ENV_FAIL_CLOSED = 'MEMNOX_HOOK_FAIL_CLOSED';

export const HOOK_AGENT = {
  CLAUDE_CODE: 'claude-code',
  CURSOR: 'cursor',
} as const;

export const SUPPORTED_HOOK_AGENTS: readonly string[] = Object.values(HOOK_AGENT);

interface Refusal {
  reason: string;
  decision: Decision | null;
}

/** How the hook reaches credentials its environment does not carry. Injected so tests never read $HOME. */
type StoredConfigReader = () => Promise<AgentConfig>;

const storedConfig: StoredConfigReader = () => readAgentConfig(homedir());

interface HookCredentials {
  token: string;
  url: string;
}

/**
 * Environment first — that is how CI and the MCP firewall pass a token. The
 * config file is the fallback that makes the hook work at all inside a
 * GUI-launched editor, which starts with no environment to inherit.
 */
async function resolveCredentials(
  host: HookHost,
  readStored: StoredConfigReader,
): Promise<HookCredentials | null> {
  const stored = await readStored();
  const token = host.env(ENV_AGENT_TOKEN) ?? stored.token;
  if (!token) return null;
  return { token, url: host.env(ENV_RUNTIME_URL) ?? stored.url ?? DEFAULT_BASE_URL };
}

export function registerHookCommand(
  program: Command,
  context: CliContext,
  host: HookHost = processHookHost,
  readStored: StoredConfigReader = storedConfig,
): void {
  program
    .command('hook <agent>')
    .description(
      `Editor hook entry point — reads the tool call from stdin (${SUPPORTED_HOOK_AGENTS.join('|')})`,
    )
    .action(async (agent: string) => {
      if (agent === HOOK_AGENT.CLAUDE_CODE) {
        return runClaudeCodeHook(context, host, readStored);
      }
      if (agent === HOOK_AGENT.CURSOR) return runCursorHook(context, host, readStored);
      throw new Error(
        `unsupported hook agent "${agent}" — expected one of: ${SUPPORTED_HOOK_AGENTS.join(', ')}`,
      );
    });
}

/**
 * Shared core: the offline shield runs first so it still blocks when the runtime
 * is down, then the local rules — which are the only ones that see the call's
 * arguments — and the runtime decides last. Null means the action may proceed.
 */
async function evaluate(
  context: CliContext,
  host: HookHost,
  request: ActionRequest,
  credentials: HookCredentials,
): Promise<Refusal | null> {
  const shieldDenial = localShieldDenial(request);
  if (shieldDenial) return { reason: shieldDenial, decision: null };

  const local = await localVerdict(request, host);
  if (local !== null && local.effect !== DECISION_EFFECT.ALLOW) {
    return {
      reason: `Memnox ${local.effect}: ${withPeriod(local.reason)}`,
      decision: null,
    };
  }

  const client = context.client({ url: credentials.url, token: credentials.token });

  try {
    const decision = await client.check(
      withSignals(request, local === null ? [] : local.signals),
    );
    if (decision.effect === DECISION_EFFECT.ALLOW) return null;
    const approvalHint = decision.approvalId
      ? ` Ask a human to run: memnox approvals resolve ${decision.approvalId} --by <name>, then retry.`
      : '';
    return {
      reason: `Memnox ${decision.effect}: ${withPeriod(decision.reason)}${approvalHint}`,
      decision,
    };
  } catch (err) {
    if (host.env(ENV_FAIL_CLOSED) === 'true') {
      return {
        reason: `Memnox runtime unreachable — failing closed: ${String(err)}`,
        decision: null,
      };
    }
    return null; // Default: a stopped runtime never blocks development.
  }
}

/**
 * Stamps the governance unit onto a request. The editor already reports its
 * working directory; the project it belongs to is declared in the policy file
 * found from there, so two repos of one project resolve to one scope.
 */
function withProject(
  request: ActionRequest | null,
  cwd: string | undefined,
): ActionRequest | null {
  if (request === null) return null;
  const projectId = resolveProjectId(cwd);
  if (projectId === undefined) return request;
  return { ...request, projectId };
}

/** Policy reasons are author-written and may or may not already be punctuated. */
function withPeriod(reason: string): string {
  return reason.endsWith('.') ? reason : `${reason}.`;
}

async function runClaudeCodeHook(
  context: CliContext,
  host: HookHost,
  readStored: StoredConfigReader,
): Promise<void> {
  const credentials = await resolveCredentials(host, readStored);
  if (!credentials) return; // Not configured — never break the editor.

  const payload = await readJsonInput<ClaudeCodeHookPayload>(host);
  if (!payload) return;
  const request = withProject(mapHookPayload(payload), payload.cwd);
  if (!request) return;

  const refusal = await evaluate(context, host, request, credentials);
  if (!refusal) return;

  // Claude Code convention: exit 2 with stderr denies the tool call.
  host.warn(refusal.reason);
  host.exit(HOOK_EXIT_BLOCK);
}

async function runCursorHook(
  context: CliContext,
  host: HookHost,
  readStored: StoredConfigReader,
): Promise<void> {
  const allow = (): void =>
    respondToCursor(host, { permission: CURSOR_PERMISSION.ALLOW });

  const credentials = await resolveCredentials(host, readStored);
  if (!credentials) return allow();

  const payload = await readJsonInput<CursorHookPayload>(host);
  if (!payload) return allow();
  const request = withProject(mapCursorPayload(payload), payload.cwd);
  if (!request) return allow();

  const refusal = await evaluate(context, host, request, credentials);
  if (!refusal) return allow();

  // afterFileEdit fires once the edit has landed; reporting is all that is left.
  if (payload.hook_event_name === CURSOR_AFTER_FILE_EDIT) {
    host.warn(refusal.reason);
    return allow();
  }

  respondToCursor(host, {
    permission: refusal.decision
      ? toCursorPermission(refusal.decision.effect)
      : CURSOR_PERMISSION.DENY,
    agent_message: refusal.reason,
    user_message: refusal.reason,
  });
}

/** Cursor reads the verdict as JSON on stdout; exit 0 means "use my JSON". */
function respondToCursor(host: HookHost, response: CursorHookResponse): void {
  host.respond(JSON.stringify(response));
}

/**
 * Rules evaluated here, against the call's own arguments, from the policy file
 * that governs this working directory. It is the only place those arguments are
 * ever read — the SDK strips them, so an `arguments:` rule has no other home.
 *
 * A secret found in an argument only reports by default: a hook that blocks on
 * its own scanner would fail the editor closed, which this hook never does. Set
 * MEMNOX_ON_SECRET=block to change that.
 */
async function localVerdict(
  request: ActionRequest,
  host: HookHost,
): Promise<LocalVerdict | null> {
  const cwd = request.workingDirectory;
  if (cwd === undefined) return null; // Nothing to resolve rules from.

  const policyFile = findPolicyFile(cwd);
  if (policyFile === undefined) return null;

  try {
    const gate = await LocalGate.fromFiles([policyFile], {
      agentName: HOOK_AGENT_NAME,
      onSecret: SECRET_RESPONSE.SIGNAL,
    });
    return gate.evaluate(request);
  } catch (err) {
    // An invalid rule file is `memnox validate`'s error to report, not a blocked editor.
    host.warn(`Memnox local rules skipped: ${String(err)}`);
    return null;
  }
}

/**
 * What travels: the action, its target, the context — and rule ids for what the
 * local pass found. The arguments and the written content stay on this machine.
 */
function withSignals(request: ActionRequest, signals: string[]): ActionRequest {
  const { arguments: _payload, metadata, ...rest } = request;
  const withoutContent =
    metadata === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(metadata).filter(([key]) => key !== CONTENT_METADATA_KEY),
        );
  return {
    ...rest,
    ...(withoutContent === undefined || Object.keys(withoutContent).length === 0
      ? {}
      : { metadata: withoutContent }),
    ...(signals.length === 0 ? {} : { signals }),
  };
}

function localShieldDenial(request: ActionRequest): string | null {
  if (!CONTENT_SCANNED_ACTIONS.includes(request.action)) return null;
  const target = request.target;
  const metadata = request.metadata;
  const content = metadata === undefined ? undefined : metadata[CONTENT_METADATA_KEY];
  if (!target || typeof content !== 'string' || content.length === 0) return null;
  return shieldDenialMessage(target, content, readFileIfExists(target));
}

function readFileIfExists(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null; // New file, or unreadable — every finding then counts as introduced.
  }
}

async function readJsonInput<T>(host: HookHost): Promise<T | null> {
  const raw = await host.readInput();
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null; // Unparseable hook input — fail open.
  }
}
