import type { DiscoveryReport } from './discover';
import {
  FINDING_SEVERITY,
  SENSITIVITY,
  SEVERITY_ORDER,
  SURFACE_KIND,
  TOOL_EFFECT,
  type FindingSeverity,
} from './discovery.constants';
import { OUTBOUND_STATE } from './network';
import { distinctTools, type McpTool } from './surface';

/**
 * Fixed rules, evaluated in order, each naming itself when it fires, because a band that
 * lists what fired is one somebody can argue with.
 */

export const RISK_RULE = {
  DESTRUCTIVE_TOOL: 'destructive-tool',
  SECRET_REACHED: 'secret-reachable',
  WRITE_PLUS_CREDENTIAL: 'write-tool-with-credential',
  UNPROBED_SERVER: 'unprobed-server',
  SHELL_SURFACE: 'shell-surface',
  UNRESTRICTED_EGRESS: 'unrestricted-egress',
  WRITE_TOOL: 'write-tool',
  COMBINED_CAPABILITY: 'combined-capability',
} as const;

export type RiskRule = (typeof RISK_RULE)[keyof typeof RISK_RULE];

export interface FiredRule {
  rule: RiskRule;
  /** The count or name that made it fire, so the line is evidence and not a claim. */
  because: string;
  contributes: FindingSeverity;
}

export interface RiskBand {
  level: FindingSeverity;
  fired: FiredRule[];
}

function strongest(levels: readonly FindingSeverity[]): FindingSeverity {
  return levels.reduce(
    (worst, level) => (SEVERITY_ORDER[level] > SEVERITY_ORDER[worst] ? level : worst),
    FINDING_SEVERITY.LOW,
  );
}

/** One rule: what it counted, and the line it prints when that count is not zero. */
type RuleCheck = (report: DiscoveryReport, tools: readonly McpTool[]) => FiredRule | null;

/** Evaluated in this order, which is the order the fired rules print in. */
const RULE_CHECKS: readonly RuleCheck[] = [
  destructiveTools,
  combinedCapability,
  secretReached,
  writePlusCredential,
  unprobedServers,
  shellSurfaces,
  unrestrictedEgress,
  writeTools,
];

export function bandFor(report: DiscoveryReport): RiskBand {
  // Distinct: one server in five editors is not five times the risk.
  const tools = distinctTools(report.surfaces);
  const fired = RULE_CHECKS.map((check) => check(report, tools)).filter(
    (rule): rule is FiredRule => rule !== null,
  );
  return { level: strongest(fired.map((rule) => rule.contributes)), fired };
}

function destructiveTools(
  _report: DiscoveryReport,
  tools: readonly McpTool[],
): FiredRule | null {
  const destructive = tools.filter((tool) => tool.effect === TOOL_EFFECT.DESTRUCTIVE);
  if (destructive.length === 0) return null;
  return {
    rule: RISK_RULE.DESTRUCTIVE_TOOL,
    because: `${destructive.length} tool(s) can destroy or exfiltrate`,
    contributes: FINDING_SEVERITY.CRITICAL,
  };
}

/** A path a set of permitted tools opens together, which no one-call review ever catches. */
function combinedCapability(report: DiscoveryReport): FiredRule | null {
  const chains = report.combined.flatMap((each) =>
    each.capabilities.filter((capability) => capability.individuallyHarmless),
  );
  if (chains.length === 0) return null;
  return {
    rule: RISK_RULE.COMBINED_CAPABILITY,
    because: `${chains.length} path(s) a set of ordinary tools opens together`,
    contributes: FINDING_SEVERITY.HIGH,
  };
}

function secretReached(report: DiscoveryReport): FiredRule | null {
  const reached = report.resources.filter(
    (resource) =>
      resource.sensitivity !== SENSITIVITY.ORDINARY && resource.reachableBy.length > 0,
  );
  if (reached.length === 0) return null;
  return {
    rule: RISK_RULE.SECRET_REACHED,
    because: `${reached.length} sensitive path(s) reachable by an agent here`,
    contributes: FINDING_SEVERITY.CRITICAL,
  };
}

/** Credential names ride on the launch line that declares the server, not the surface. */
function credentialedSurfaces(report: DiscoveryReport): number {
  return report.surfaces.filter((surface) =>
    (surface.servers ?? []).some((server) => (server.env ?? []).length > 0),
  ).length;
}

function writeCount(tools: readonly McpTool[]): number {
  return tools.filter((tool) => tool.effect === TOOL_EFFECT.WRITE).length;
}

function writePlusCredential(
  report: DiscoveryReport,
  tools: readonly McpTool[],
): FiredRule | null {
  const writes = writeCount(tools);
  const credentialed = credentialedSurfaces(report);
  if (writes === 0 || credentialed === 0) return null;
  return {
    rule: RISK_RULE.WRITE_PLUS_CREDENTIAL,
    because: `${writes} write tool(s) alongside ${credentialed} credentialed surface(s)`,
    contributes: FINDING_SEVERITY.HIGH,
  };
}

/** Only an MCP surface has servers to start, so a shell holding no tools is not one. */
function unprobedServers(report: DiscoveryReport): FiredRule | null {
  const unprobed = report.surfaces.filter(
    (surface) => surface.kind === SURFACE_KIND.MCP && (surface.tools ?? []).length === 0,
  );
  if (unprobed.length === 0) return null;
  return {
    rule: RISK_RULE.UNPROBED_SERVER,
    because: `${unprobed.length} server(s) were never started, so their tools are unknown`,
    contributes: FINDING_SEVERITY.MEDIUM,
  };
}

function shellSurfaces(report: DiscoveryReport): FiredRule | null {
  const shells = report.reachability.filter((entry) => entry.viaShell);
  if (shells.length === 0) return null;
  return {
    rule: RISK_RULE.SHELL_SURFACE,
    because: `${shells.length} agent(s) hold a shell, which reaches everything you can`,
    contributes: FINDING_SEVERITY.HIGH,
  };
}

function unrestrictedEgress(
  report: DiscoveryReport,
  tools: readonly McpTool[],
): FiredRule | null {
  if (report.egress.outbound !== OUTBOUND_STATE.UNKNOWN || tools.length === 0)
    return null;
  return {
    rule: RISK_RULE.UNRESTRICTED_EGRESS,
    because: 'nothing in the environment restricts or observes outbound traffic',
    contributes: FINDING_SEVERITY.MEDIUM,
  };
}

function writeTools(
  report: DiscoveryReport,
  tools: readonly McpTool[],
): FiredRule | null {
  const writes = writeCount(tools);
  if (writes === 0 || credentialedSurfaces(report) > 0) return null;
  return {
    rule: RISK_RULE.WRITE_TOOL,
    because: `${writes} tool(s) change external state`,
    contributes: FINDING_SEVERITY.MEDIUM,
  };
}
