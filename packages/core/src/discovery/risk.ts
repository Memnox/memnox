import type { DiscoveryReport } from './discover';
import { distinctTools } from './surface';
import { OUTBOUND_STATE } from './network';
import {
  FINDING_SEVERITY,
  SENSITIVITY,
  TOOL_EFFECT,
  type FindingSeverity,
} from './discovery.constants';

/**
 * Fixed rules, evaluated in order, each one naming itself when it fires. A band with
 * no rules behind it is a number somebody has to trust; a band that lists what fired
 * is one they can argue with, which is the only kind worth printing.
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

const SEVERITY_ORDER: readonly FindingSeverity[] = [
  FINDING_SEVERITY.LOW,
  FINDING_SEVERITY.MEDIUM,
  FINDING_SEVERITY.HIGH,
  FINDING_SEVERITY.CRITICAL,
];

function strongest(levels: readonly FindingSeverity[]): FindingSeverity {
  return levels.reduce(
    (worst, level) =>
      SEVERITY_ORDER.indexOf(level) > SEVERITY_ORDER.indexOf(worst) ? level : worst,
    FINDING_SEVERITY.LOW,
  );
}

export function bandFor(report: DiscoveryReport): RiskBand {
  const fired: FiredRule[] = [];
  // Distinct: one server in five editors is not five times the risk.
  const tools = distinctTools(report.surfaces);

  const destructive = tools.filter((tool) => tool.effect === TOOL_EFFECT.DESTRUCTIVE);
  if (destructive.length > 0) {
    fired.push({
      rule: RISK_RULE.DESTRUCTIVE_TOOL,
      because: `${destructive.length} tool(s) can destroy or exfiltrate`,
      contributes: FINDING_SEVERITY.CRITICAL,
    });
  }

  /* A path a set of permitted tools opens that no single one of them opens. It sits
     with the destructive rule because the consequence is the same and the review that
     would have caught it does not exist: every step passes on its own. */
  const chains = report.combined.flatMap((each) =>
    each.capabilities.filter((capability) => capability.individuallyHarmless),
  );
  if (chains.length > 0) {
    fired.push({
      rule: RISK_RULE.COMBINED_CAPABILITY,
      because: `${chains.length} path(s) a set of ordinary tools opens together`,
      contributes: FINDING_SEVERITY.HIGH,
    });
  }

  const reachedSecrets = report.resources.filter(
    (resource) =>
      resource.sensitivity !== SENSITIVITY.ORDINARY && resource.reachableBy.length > 0,
  );
  if (reachedSecrets.length > 0) {
    fired.push({
      rule: RISK_RULE.SECRET_REACHED,
      because: `${reachedSecrets.length} sensitive path(s) reachable by an agent here`,
      contributes: FINDING_SEVERITY.CRITICAL,
    });
  }

  const writes = tools.filter((tool) => tool.effect === TOOL_EFFECT.WRITE);
  // Credential names ride on the launch line that declares the server, not the surface.
  const credentialed = report.surfaces.filter((surface) =>
    (surface.servers ?? []).some((server) => (server.env ?? []).length > 0),
  );
  if (writes.length > 0 && credentialed.length > 0) {
    fired.push({
      rule: RISK_RULE.WRITE_PLUS_CREDENTIAL,
      because: `${writes.length} write tool(s) alongside ${credentialed.length} credentialed surface(s)`,
      contributes: FINDING_SEVERITY.HIGH,
    });
  }

  const unprobed = report.surfaces.filter(
    (surface) => surface.tools === undefined || surface.tools.length === 0,
  );
  if (unprobed.length > 0) {
    fired.push({
      rule: RISK_RULE.UNPROBED_SERVER,
      because: `${unprobed.length} server(s) were never started, so their tools are unknown`,
      contributes: FINDING_SEVERITY.MEDIUM,
    });
  }

  const shells = report.reachability.filter((entry) => entry.viaShell);
  if (shells.length > 0) {
    fired.push({
      rule: RISK_RULE.SHELL_SURFACE,
      because: `${shells.length} agent(s) hold a shell, which reaches everything you can`,
      contributes: FINDING_SEVERITY.HIGH,
    });
  }

  if (report.egress.outbound === OUTBOUND_STATE.UNKNOWN && tools.length > 0) {
    fired.push({
      rule: RISK_RULE.UNRESTRICTED_EGRESS,
      because: 'nothing in the environment restricts or observes outbound traffic',
      contributes: FINDING_SEVERITY.MEDIUM,
    });
  }

  if (writes.length > 0 && credentialed.length === 0) {
    fired.push({
      rule: RISK_RULE.WRITE_TOOL,
      because: `${writes.length} tool(s) change external state`,
      contributes: FINDING_SEVERITY.MEDIUM,
    });
  }

  return { level: strongest(fired.map((rule) => rule.contributes)), fired };
}
