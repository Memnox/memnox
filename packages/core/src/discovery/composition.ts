import { nameSegments, type McpTool } from './surface';
import { TOOL_EFFECT } from './discovery.constants';

/**
 * The step a tool plays in a chain. A tool allow-list checks one call at a time, which
 * is the right thing to check and not the only thing: `read_customer`, `create_export`
 * and `send_file` are each unremarkable, and holding all three is an exfiltration path.
 */
export const CHAIN_LINK = {
  /** Gets hold of something worth having. */
  ACQUIRE: 'acquire',
  /** Turns it into one movable artifact. */
  PACKAGE: 'package',
  /** Puts it somewhere the reader's organization does not control. */
  EMIT: 'emit',
} as const;

export type ChainLink = (typeof CHAIN_LINK)[keyof typeof CHAIN_LINK];

/** Verbs, by the step they play. A name is all a tool name carries, and this says so. */
const LINK_VERBS: Record<ChainLink, readonly string[]> = {
  [CHAIN_LINK.ACQUIRE]: [
    'read',
    'get',
    'list',
    'search',
    'query',
    'fetch',
    'download',
    'dump',
    'describe',
  ],
  [CHAIN_LINK.PACKAGE]: ['export', 'archive', 'backup', 'snapshot', 'render', 'bundle'],
  [CHAIN_LINK.EMIT]: [
    'send',
    'post',
    'publish',
    'share',
    'email',
    'message',
    'notify',
    'upload',
    'invite',
    'forward',
    'webhook',
  ],
};

/**
 * Nouns worth acquiring. A chain over `list_files` in a scratch directory is noise; a
 * chain over customer records is the one somebody has to answer for. Named rather than
 * scored, because a score here would have no denominator.
 */
const SUBJECTS: readonly string[] = [
  'customer',
  'user',
  'account',
  'contact',
  'payment',
  'invoice',
  'transaction',
  'secret',
  'credential',
  'token',
  'key',
  'password',
  'record',
  'employee',
  'patient',
  'message',
  'email',
  'document',
  'file',
  'repo',
  'repository',
  'database',
  'table',
];

/** One completed path, with the tools that make it up so it can be argued with. */
export interface CombinedCapability {
  id: string;
  /** What holding all of these amounts to, in the words somebody would repeat. */
  consequence: string;
  /** The tools that form the chain, in the order they would be used. */
  steps: { link: ChainLink; server: string; tool: string }[];
  /** The subject the chain acquires, which is why it is worth printing. */
  subject: string;
  /**
   * True when no single step is destructive. This is the whole reason the chain needs
   * naming: an allow-list that reviews calls one at a time passes every one of them.
   */
  individuallyHarmless: boolean;
}

/**
 * Chains an agent can complete on its own, across every server it holds. The tools are
 * grouped by subject first, because `read_customer` plus `send_invoice` is two jobs and
 * `read_customer` plus `send_customer_report` is one path.
 */
export function combinedCapabilities(tools: readonly McpTool[]): CombinedCapability[] {
  const bySubject = new Map<string, { link: ChainLink; tool: McpTool }[]>();
  for (const tool of tools) {
    const segments = nameSegments(tool.name);
    const link = linkOf(segments);
    if (link === null) continue;
    for (const subject of segments.filter((each) => SUBJECTS.includes(each))) {
      const steps = bySubject.get(subject) ?? [];
      steps.push({ link, tool });
      bySubject.set(subject, steps);
    }
  }

  const found: CombinedCapability[] = [];
  for (const [subject, steps] of [...bySubject].sort(([a], [b]) => a.localeCompare(b))) {
    const chain = shortestChain(steps);
    if (chain === null) continue;
    found.push({
      id: `chain_${subject}`,
      consequence: consequenceOf(subject),
      steps: chain.map((step) => ({
        link: step.link,
        server: step.tool.server,
        tool: step.tool.name,
      })),
      subject,
      individuallyHarmless: chain.every(
        (step) => step.tool.effect !== TOOL_EFFECT.DESTRUCTIVE,
      ),
    });
  }
  return found;
}

/**
 * A chain needs something to take and somewhere to put it; packaging in between raises
 * confidence and is not required, because plenty of tools send what they just read.
 */
function shortestChain(
  steps: readonly { link: ChainLink; tool: McpTool }[],
): { link: ChainLink; tool: McpTool }[] | null {
  const first = (link: ChainLink): { link: ChainLink; tool: McpTool } | undefined =>
    steps.find((step) => step.link === link);

  const acquire = first(CHAIN_LINK.ACQUIRE);
  const emit = first(CHAIN_LINK.EMIT);
  if (acquire === undefined || emit === undefined) return null;
  if (acquire.tool.name === emit.tool.name) return null;

  const packaged = first(CHAIN_LINK.PACKAGE);
  return packaged === undefined ? [acquire, emit] : [acquire, packaged, emit];
}

function linkOf(segments: readonly string[]): ChainLink | null {
  // Emit before acquire: `send_report` reads something to send it, and the send is the risk.
  for (const link of [CHAIN_LINK.EMIT, CHAIN_LINK.PACKAGE, CHAIN_LINK.ACQUIRE] as const) {
    if (LINK_VERBS[link].some((verb) => segments.includes(verb))) return link;
  }
  return null;
}

/** Plain words, because "medium risk composite capability" is not a thing anybody repeats. */
function consequenceOf(subject: string): string {
  const leaving = ['customer', 'user', 'account', 'contact', 'employee', 'patient'];
  if (leaving.includes(subject)) return `${subject} data can leave, in one session`;
  if (['secret', 'credential', 'token', 'key', 'password'].includes(subject)) {
    return `a ${subject} can be read and forwarded, in one session`;
  }
  return `${subject} data can be read and sent outward, in one session`;
}

/** One agent, and every path its own tools open together. */
export interface AgentChains {
  agentId: string;
  capabilities: CombinedCapability[];
}

/**
 * Chains per agent, from whatever tools the surfaces carry. One function rather than
 * three: `discover` fills the surfaces by probing, `doctor` and `protect` fill them
 * from the last scan that did, and all three have to answer the same way or a finding
 * appears in one command and not another for no reason a reader could work out.
 */
export function chainsFor(
  agentIds: readonly string[],
  surfaces: readonly { agentId: string; tools?: McpTool[] }[],
): AgentChains[] {
  return agentIds
    .map((agentId) => ({
      agentId,
      capabilities: combinedCapabilities(
        surfaces
          .filter((surface) => surface.agentId === agentId)
          .flatMap((surface) => surface.tools ?? []),
      ),
    }))
    .filter((each) => each.capabilities.length > 0);
}

/** The line for the screen: what it is, and the tools that make it up. */
export function describeCombined(capability: CombinedCapability): string {
  return capability.steps.map((step) => `${step.server}.${step.tool}`).join(' → ');
}
