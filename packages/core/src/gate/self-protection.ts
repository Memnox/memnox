/**
 * Memnox's own rules and state are a person's to change, never an agent's. An agent that
 * could edit its rule file, run `memnox allow` or turn protection off would hold every
 * permission it wanted, so those are refused ahead of every rule, whatever the rules say.
 */
import { ACTION } from '../constants/action.constants';
import type { ActionRequest } from '../domain/action-event';

/** What a refusal here is recorded under, so `why` names it rather than a rule. */
export const SELF_PROTECTION_SIGNAL = 'self-protection';

/** The action a `memnox` command line is recorded under, per subcommand. */
export const MEMNOX_ACTION_PREFIX = 'memnox.';

/**
 * Subcommands that loosen what an agent may do, or answer for a person. Everything else
 * reads (`why`, `report`, `explain`, `status`, `policy test`) or only ever tightens.
 */
const LOOSENING: readonly string[] = [
  'allow',
  'stop',
  'mode',
  'protect',
  'uninstall',
  'resume',
  'approve',
  'approvals',
  'trust',
  'repo',
  'task',
  'config',
  'agents',
  'mcp',
  'budget',
  'policy',
  // A rewind moves a person's files, so it is asked through the session tool, never run from a shell.
  'rewind',
];

/** Reads that share a subcommand with a loosening one. */
const READING: readonly string[] = [
  'policy test',
  'policy check',
  'mode',
  'allow --list',
  'task show',
  'repo list',
  'approvals list',
  'config get',
  'agents list',
  'mcp list',
  'rewind --list',
];

const WRITES: readonly string[] = [ACTION.FILESYSTEM_WRITE, ACTION.FILESYSTEM_DELETE];

/** The Memnox home, and rule files wherever they live. Matched on the path, not the name typed. */
function isMemnoxPath(target: string): boolean {
  const path = target.replace(/\\/g, '/');
  if (path.includes('/.memnox/') || path.endsWith('/.memnox')) return true;
  const name = path.split('/').pop() ?? '';
  return (
    /^memnox\.policies\.(toml|ya?ml|json)$/.test(name) || /\.policies\.toml$/.test(name)
  );
}

/** A refusal for an agent touching what governs it, or null for anything else. */
export function selfProtection(
  request: ActionRequest,
): { reason: string; signal: string; refuses: true } | null {
  if (WRITES.includes(request.action) && request.target !== undefined) {
    if (!isMemnoxPath(request.target)) return null;
    return {
      reason: `${request.target} is Memnox's own rules or state, which a person changes and an agent never does.`,
      signal: SELF_PROTECTION_SIGNAL,
      refuses: true,
    };
  }
  if (!request.action.startsWith(MEMNOX_ACTION_PREFIX)) return null;
  const said = request.target ?? request.action.slice(MEMNOX_ACTION_PREFIX.length);
  if (!loosens(said)) return null;
  return {
    reason: `"memnox ${said}" changes what agents may do, which is a person's to run and never an agent's.`,
    signal: SELF_PROTECTION_SIGNAL,
    refuses: true,
  };
}

/** Whether a `memnox` command, from its subcommand on, changes what an agent may do. */
export function loosens(command: string): boolean {
  const words = command.trim().split(/\s+/);
  const subcommand = words[0] ?? '';
  if (!LOOSENING.includes(subcommand)) return false;
  const spoken = words.join(' ');
  // `memnox mode` with no mode reads; `memnox mode off` does not.
  if (subcommand === 'mode' && words.length === 1) return false;
  return !READING.some((read) => read !== 'mode' && spoken.startsWith(read));
}
