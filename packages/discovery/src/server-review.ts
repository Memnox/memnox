import type { DiscoveryReport } from './discover';
import type { McpServerLaunch, McpTool } from './surface';
import {
  FINDING_SEVERITY,
  TOOL_EFFECT,
  type FindingSeverity,
} from './discovery.constants';

/**
 * One server, and everything this machine can prove about it before it is trusted.
 *
 * The unit of installation is the server; the unit of danger is the tool. A reader
 * deciding whether to keep a server needs both counts in front of them, plus what the
 * config hands it, and none of that is anywhere today.
 */
export interface ServerReview {
  server: string;
  /** The config that launches it, which is the answer to "who granted this". */
  declaredIn: string;
  command: string;
  tools: number;
  read: number;
  write: number;
  destructive: number;
  /** Names only. What is stored is a key, never the value behind it. */
  credentials: string[];
  /** Whether a tool was found that reaches the filesystem or the network by name. */
  filesystem: boolean;
  network: boolean;
  risk: FindingSeverity;
  /**
   * True when the server was never started, so nothing asked it what it holds. A
   * count of zero tools on an unprobed server means unknown, not harmless.
   */
  unprobed: boolean;
}

const FILESYSTEM_WORDS = ['file', 'directory', 'path', 'fs', 'read_file', 'write_file'];
const NETWORK_WORDS = ['http', 'fetch', 'request', 'url', 'webhook', 'curl'];

/**
 * Ranked on what was counted rather than on a reputation nobody measured. There is no
 * publisher score and no install count here: this machine cannot see either, and a
 * number it invented would be the comparison score this product does not ship.
 */
function riskOf(review: Omit<ServerReview, 'risk'>): FindingSeverity {
  if (review.unprobed) return FINDING_SEVERITY.MEDIUM;
  if (review.destructive > 0) return FINDING_SEVERITY.CRITICAL;
  if (review.credentials.length > 0 && review.write > 0) return FINDING_SEVERITY.HIGH;
  if (review.write > 0) return FINDING_SEVERITY.MEDIUM;
  return FINDING_SEVERITY.LOW;
}

/** Everything a config declared, each one reviewed against the tools it turned out to hold. */
export function reviewServers(report: DiscoveryReport): ServerReview[] {
  const reviews: ServerReview[] = [];
  for (const surface of report.surfaces) {
    for (const launch of surface.servers ?? []) {
      const tools = (surface.tools ?? []).filter((tool) => tool.server === launch.name);
      reviews.push(reviewOne(launch, tools, surface.detectedFrom));
    }
  }
  return reviews.sort((a, b) => b.destructive + b.write - (a.destructive + a.write));
}

function reviewOne(
  launch: McpServerLaunch,
  tools: readonly McpTool[],
  declaredIn: string,
): ServerReview {
  const counted = {
    server: launch.name,
    declaredIn,
    command: [launch.command, ...launch.args].join(' '),
    tools: tools.length,
    read: tools.filter((tool) => tool.effect === TOOL_EFFECT.READ).length,
    write: tools.filter((tool) => tool.effect === TOOL_EFFECT.WRITE).length,
    destructive: tools.filter((tool) => tool.effect === TOOL_EFFECT.DESTRUCTIVE).length,
    credentials: [...(launch.env ?? [])],
    filesystem: mentions(tools, FILESYSTEM_WORDS),
    network: mentions(tools, NETWORK_WORDS),
    unprobed: tools.length === 0,
  };
  return { ...counted, risk: riskOf(counted) };
}

function mentions(tools: readonly McpTool[], words: readonly string[]): boolean {
  return tools.some((tool) => {
    const text = `${tool.name} ${tool.description ?? ''}`.toLowerCase();
    return words.some((word) => text.includes(word));
  });
}
