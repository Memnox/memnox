import { randomUUID } from 'node:crypto';
import type { Reachability } from './reachability';
import type { Resource } from './resource';
import { RESOURCE_KIND, type ResourceKind } from './discovery.constants';
import type { Surface } from './surface';
import {
  agentIdsOf,
  rankFindings,
  severityOfResource,
  type Finding,
  type HardenStep,
} from './finding';
import {
  FINDING_SEVERITY,
  HARDEN_MODE,
  HARDEN_TARGET,
  SENSITIVITY,
  SURFACE_KIND,
  TOOL_EFFECT,
  type FindingSeverity,
} from './discovery.constants';

/**
 * A decomposition of this machine's findings and nothing else. It grants nothing, it
 * changes no permission, and it is never a rank against anybody else's machine.
 */
export interface RiskScore {
  total: number;
  /** The list underneath the number, so the number can be argued with. */
  bySeverity: Record<FindingSeverity, number>;
}

const SEVERITY_WEIGHT: Record<FindingSeverity, number> = {
  [FINDING_SEVERITY.LOW]: 1,
  [FINDING_SEVERITY.MEDIUM]: 3,
  [FINDING_SEVERITY.HIGH]: 8,
  [FINDING_SEVERITY.CRITICAL]: 20,
};

export function scoreFindings(findings: readonly Finding[]): RiskScore {
  const bySeverity: Record<FindingSeverity, number> = {
    [FINDING_SEVERITY.LOW]: 0,
    [FINDING_SEVERITY.MEDIUM]: 0,
    [FINDING_SEVERITY.HIGH]: 0,
    [FINDING_SEVERITY.CRITICAL]: 0,
  };
  let total = 0;
  for (const finding of findings) {
    bySeverity[finding.severity] += 1;
    total += SEVERITY_WEIGHT[finding.severity];
  }
  return { total, bySeverity };
}

export interface DoctorInput {
  resources: readonly Resource[];
  reachability: readonly Reachability[];
  surfaces: readonly Surface[];
  /** Injected so a report is reproducible and a test is not a coin toss. */
  newId?: () => string;
}

export interface DoctorReport {
  findings: Finding[];
  score: RiskScore;
}

/**
 * Each finding names the agent, the resource, the evidence and the one change that
 * closes it. Nothing here estimates a loss, and nothing compares this machine to another.
 */
export function runDoctor(input: DoctorInput): DoctorReport {
  const newId = input.newId ?? randomUUID;
  const findings: Finding[] = [];

  for (const resource of input.resources) {
    if (resource.sensitivity === SENSITIVITY.ORDINARY) continue;
    if (resource.reachableBy.length === 0) continue;
    const path = resource.path ?? resource.id;
    const id = newId();
    findings.push({
      id,
      severity: severityOfResource(resource),
      title: `${path} is readable by ${resource.reachableBy.length} agent(s)`,
      agentIds: agentIdsOf(resource.reachableBy),
      resourceId: resource.id,
      evidence: path,
      remediation: withholdReadStep(id, path, resource.kind),
    });
  }

  for (const surface of input.surfaces) {
    const destructive = (surface.tools ?? []).filter(
      (tool) => tool.effect === TOOL_EFFECT.DESTRUCTIVE,
    );
    if (destructive.length === 0) continue;
    const id = newId();
    findings.push({
      id,
      severity: FINDING_SEVERITY.HIGH,
      title: `${destructive.length} destructive tool(s) on ${surface.kind}, and nothing is checking any of them`,
      agentIds: [surface.agentId],
      evidence: surface.detectedFrom,
      remediation: escalateToolStep(
        id,
        destructive.map((tool) => `${tool.server}.${tool.name}`),
      ),
    });
  }

  const unrestricted = input.reachability.filter((entry) => entry.viaShell);
  for (const entry of unrestricted) {
    const id = newId();
    findings.push({
      id,
      severity: FINDING_SEVERITY.MEDIUM,
      title: `a shell surface makes everything the user can reach reachable from this agent`,
      agentIds: [entry.agentId],
      evidence: SURFACE_KIND.SHELL,
    });
  }

  const ranked = rankFindings(findings);
  return { findings: ranked, score: scoreFindings(ranked) };
}

const POLICY_DIR = 'policies';

/**
 * A substitute exists for a credential file that conventionally has an example beside
 * it. Nothing plausible substitutes for a container socket, and inventing one would
 * send an agent at a path that is not there — worse than a refusal with no alternative.
 */
function substituteFor(path: string, kind: ResourceKind): string | null {
  if (kind === RESOURCE_KIND.SOCKET) return null;
  if (/(^|\/)\.env(\.[a-z0-9_-]+)?$/.test(path)) return `${path}.example`;
  if (/(^|\/)\.npmrc$/.test(path)) return null;
  if (/(^|\/)\.ssh\//.test(path)) return null;
  return null;
}

/** Enforcing on a credential read is unambiguous, so this one arrives armed. */
function withholdReadStep(
  findingId: string,
  path: string,
  kind: ResourceKind,
): HardenStep {
  const file = `${POLICY_DIR}/withhold-${slug(path)}.yaml`;
  const substitute = substituteFor(path, kind);
  const contents = [
    'version: 1',
    'policies:',
    `  - name: withhold-${slug(path)}`,
    '    match:',
    '      actions: ["filesystem.read"]',
    `      targets: ["${path}"]`,
    '    decision:',
    '      effect: withhold',
    `      reason: "${path} holds a credential this task did not declare a need for."`,
    ...(substitute === null
      ? []
      : [
          '      alternative:',
          '        action: filesystem.read',
          `        resource: "${substitute}"`,
          `        note: "${substitute} is readable."`,
        ]),
    '',
  ].join('\n');
  return {
    id: `hs_${findingId}`,
    target: HARDEN_TARGET.POLICY,
    seam: SURFACE_KIND.FILESYSTEM,
    description:
      substitute === null
        ? `withhold reads of ${path}`
        : `withhold reads of ${path}, naming ${substitute} instead`,
    apply: { path: file, contents, command: `memnox harden --apply hs_${findingId}` },
    revert: { path: file, command: `memnox harden --revert hs_${findingId}` },
    mode: HARDEN_MODE.ENFORCE,
  };
}

/** Ambiguous by nature: somebody may legitimately want the tool, so it asks first. */
function escalateToolStep(findingId: string, tools: readonly string[]): HardenStep {
  const file = `${POLICY_DIR}/escalate-destructive-tools.yaml`;
  const contents = [
    'version: 1',
    'policies:',
    '  - name: escalate-destructive-tools',
    '    match:',
    `      actions: [${tools.map((tool) => `"mcp.${tool}"`).join(', ')}]`,
    '    decision:',
    '      effect: escalate',
    '      approvers: ["you"]',
    '      reason: "A destructive tool call needs a person."',
    '',
  ].join('\n');
  return {
    id: `hs_${findingId}`,
    target: HARDEN_TARGET.POLICY,
    seam: SURFACE_KIND.MCP,
    description: `ask before ${tools.length} destructive tool call(s)`,
    apply: { path: file, contents, command: `memnox harden --apply hs_${findingId}` },
    revert: { path: file, command: `memnox harden --revert hs_${findingId}` },
    mode: HARDEN_MODE.ENFORCE,
  };
}

function slug(path: string): string {
  return path
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}
