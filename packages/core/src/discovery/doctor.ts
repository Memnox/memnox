import { randomUUID } from 'node:crypto';
import { agentNameIn } from './agent';
import {
  describeCombined,
  type AgentChains,
  type CombinedCapability,
} from './composition';
import {
  FINDING_KIND,
  FINDING_SEVERITY,
  PRODUCTION_HINTS,
  RESOURCE_KIND,
  SENSITIVITY,
  SURFACE_KIND,
  TOOL_EFFECT,
  type FindingSeverity,
  type ResourceKind,
} from './discovery.constants';
import {
  agentIdsOf,
  countBySeverity,
  rankFindings,
  severityOfResource,
  type Finding,
  type SeverityCounts,
} from './finding';
import type { Reachability } from './reachability';
import {
  ASK_CHAIN_EXIT,
  askProductionStep,
  askToolStep,
  denyReadStep,
  osGuardStep,
} from './remediation-steps';
import type { Resource } from './resource';
import { nameSegments, type Surface } from './surface';

/**
 * A decomposition of this machine's findings and nothing else. It grants nothing, changes
 * no permission, and is never a rank against anybody else's machine.
 */
export interface DoctorInput {
  resources: readonly Resource[];
  reachability: readonly Reachability[];
  surfaces: readonly Surface[];
  /** Tool chains from the scan. Absent when nothing asked the servers what they hold. */
  chains?: readonly AgentChains[];
  /**
   * Which rule already denies reading a path, so applying a fix changes the next report.
   * A function, because `~/.ssh/*` covers keys it never names. Absent means ungoverned.
   */
  governedBy?: GovernedBy;
  /** Injected so a report is reproducible and a test is not a coin toss. */
  newId?: NewId;
}

/** Answers with the name of the rule that denies reading this path, or nothing. */
export type GovernedBy = (path: string) => string | undefined;

/** A new id per finding. */
type NewId = () => string;

/** Withholding by path closes a file. It closes nothing for a database or a network. */
const CLOSABLE_BY_PATH: readonly string[] = [
  RESOURCE_KIND.FILE,
  RESOURCE_KIND.SECRET,
  RESOURCE_KIND.REPO,
  RESOURCE_KIND.SOCKET,
];

/**
 * One rung down, never to nothing: a rule covers the seams and not a process that never
 * meets one, so a governed credential is safer and not sealed.
 */
const MITIGATED: Record<FindingSeverity, FindingSeverity> = {
  [FINDING_SEVERITY.CRITICAL]: FINDING_SEVERITY.MEDIUM,
  [FINDING_SEVERITY.HIGH]: FINDING_SEVERITY.MEDIUM,
  [FINDING_SEVERITY.MEDIUM]: FINDING_SEVERITY.LOW,
  [FINDING_SEVERITY.LOW]: FINDING_SEVERITY.LOW,
};

/** A tool that can address somebody outside this machine, matched on whole name segments. */
const OUTWARD_TOOL_VERBS: readonly string[] = [
  'send',
  'post',
  'publish',
  'notify',
  'mail',
  'email',
];

export interface DoctorReport {
  findings: Finding[];
  /** How many of each severity. A total would be a score, which is unarguable. */
  counts: SeverityCounts;
}

/**
 * Six independent passes over the same machine, one per kind of finding, so the reason a
 * credential was flagged is never buried in the tool-chain logic.
 */
export function runDoctor(input: DoctorInput): DoctorReport {
  const newId = input.newId ?? randomUUID;
  const governedBy = input.governedBy ?? ((): undefined => undefined);

  const findings = [
    ...reachableResources(input, newId, governedBy),
    ...uncheckedDestructiveTools(input, newId),
    ...productionReachable(input, newId),
    ...exportCombinations(input, newId),
    ...harmlessLookingChains(input, newId),
    ...shellSurfaces(input, newId),
  ];

  const ranked = rankFindings(findings);
  return { findings: ranked, counts: countBySeverity(ranked) };
}

/**
 * A sensitive file or store an agent here can read. Only a file can be denied by path,
 * so only a file is offered a deny rule: one against "postgres URL" matches nothing.
 */
function reachableResources(
  input: DoctorInput,
  newId: NewId,
  governedBy: GovernedBy,
): Finding[] {
  return input.resources
    .filter(
      (resource) =>
        resource.sensitivity !== SENSITIVITY.ORDINARY && resource.reachableBy.length > 0,
    )
    .map((resource) => reachableFinding(resource, newId(), governedBy));
}

function reachableFinding(
  resource: Resource,
  id: string,
  governedBy: GovernedBy,
): Finding {
  const path = resource.path ?? resource.id;
  const closable = CLOSABLE_BY_PATH.includes(resource.kind);
  // Asked only where a rule could have been written: nothing denies reads of the network.
  const rule = closable ? governedBy(path) : undefined;
  const severity = severityOfResource(resource);
  return {
    id,
    kind: FINDING_KIND.SENSITIVE_RESOURCE_REACHABLE,
    severity: rule === undefined ? severity : MITIGATED[severity],
    title: reachableTitle(path, resource.reachableBy.length, rule, closable),
    agentIds: agentIdsOf(resource.reachableBy),
    resourceId: resource.id,
    evidence: resource.declaredIn ?? path,
    ...reachableRemediation({ id, path, kind: resource.kind, rule, closable }),
  };
}

interface RemediationInput {
  id: string;
  path: string;
  kind: ResourceKind;
  rule: string | undefined;
  closable: boolean;
}

/**
 * With the deny written, what is left is the process that never meets a seam, which only
 * the kernel guard closes. Offering the deny again is how a person stops reading.
 */
function reachableRemediation(input: RemediationInput): Pick<Finding, 'remediation'> {
  if (input.rule !== undefined) return { remediation: osGuardStep(input.id) };
  if (input.closable)
    return { remediation: denyReadStep(input.id, input.path, input.kind) };
  return {};
}

/** Named three ways, because a governed path, a closable one and the network differ. */
function reachableTitle(
  path: string,
  agents: number,
  rule: string | undefined,
  closable: boolean,
): string {
  if (rule !== undefined) {
    return `${path} is readable by ${agents} agent(s), and "${rule}" denies it at the seams`;
  }
  if (closable) return `${path} is readable by ${agents} agent(s)`;
  return `${path} is reachable by ${agents} agent(s), and a person decides what to do about it`;
}

/** Tools that destroy something, on a surface with nothing in front of it. */
function uncheckedDestructiveTools(input: DoctorInput, newId: NewId): Finding[] {
  const found: Finding[] = [];
  for (const surface of input.surfaces) {
    const destructive = (surface.tools ?? []).filter(
      (tool) => tool.effect === TOOL_EFFECT.DESTRUCTIVE,
    );
    if (destructive.length === 0) continue;

    const id = newId();
    found.push({
      id,
      kind: FINDING_KIND.UNCHECKED_DESTRUCTIVE_TOOLS,
      severity: FINDING_SEVERITY.HIGH,
      title: `${destructive.length} destructive tool(s) on ${surface.kind}, and nothing is checking any of them`,
      agentIds: [surface.agentId],
      evidence: surface.detectedFrom,
      remediation: askToolStep(
        id,
        destructive.map((tool) => `${tool.server}.${tool.name}`),
      ),
    });
  }
  return found;
}

/** Something that reads as production, reachable while somebody does local work. */
function productionReachable(input: DoctorInput, newId: NewId): Finding[] {
  const found: Finding[] = [];
  for (const resource of input.resources) {
    if (!readsAsProduction(resource)) continue;
    if (resource.reachableBy.length === 0) continue;

    const id = newId();
    const name = resource.path ?? resource.id;
    found.push({
      id,
      kind: FINDING_KIND.PRODUCTION_REACHABLE,
      severity: FINDING_SEVERITY.HIGH,
      title: `${name} is production, and ${resource.reachableBy.length} agent(s) here reach it while doing local work`,
      agentIds: agentIdsOf(resource.reachableBy),
      resourceId: resource.id,
      evidence: resource.declaredIn ?? name,
      remediation: askProductionStep(id),
    });
  }
  return found;
}

/** Read a secret, write a file, send it outward: three ordinary permissions, one export. */
function exportCombinations(input: DoctorInput, newId: NewId): Finding[] {
  return exportPaths(input).map((combination) => ({
    id: newId(),
    kind: FINDING_KIND.EXPORT_PATH,
    severity: FINDING_SEVERITY.HIGH,
    title: `${agentNameIn(combination.agentId)} can read sensitive data, write files and send outward, and together that is an export, and no single rule refuses it`,
    agentIds: [combination.agentId],
    evidence: combination.evidence.join(' + '),
  }));
}

/**
 * The same shape one level down, where the chain is named tools. Only chains no single
 * step would be refused for, since the destructive ones already have a finding.
 */
function harmlessLookingChains(input: DoctorInput, newId: NewId): Finding[] {
  return (input.chains ?? []).flatMap(({ agentId, capabilities }) =>
    capabilities
      .filter((chain) => chain.individuallyHarmless)
      .map((chain) => chainFinding(agentId, chain, newId())),
  );
}

function chainFinding(agentId: string, chain: CombinedCapability, id: string): Finding {
  const emit = chain.steps[chain.steps.length - 1];
  return {
    id,
    kind: FINDING_KIND.TOOL_CHAIN,
    severity: FINDING_SEVERITY.HIGH,
    title: `${agentNameIn(agentId)}: ${chain.consequence}, and every tool in the path is ordinary on its own`,
    agentIds: [agentId],
    evidence: describeCombined(chain),
    // Asking where data leaves breaks the chain and costs least: the reads are the job.
    ...(emit === undefined
      ? {}
      : {
          remediation: askToolStep(id, [`${emit.server}.${emit.tool}`], ASK_CHAIN_EXIT),
        }),
  };
}

/** A shell, which reaches everything the person running the agent can reach. */
function shellSurfaces(input: DoctorInput, newId: NewId): Finding[] {
  return input.reachability
    .filter((entry) => entry.viaShell)
    .map((entry) => ({
      id: newId(),
      kind: FINDING_KIND.SHELL_SURFACE,
      severity: FINDING_SEVERITY.MEDIUM,
      // Named, or two agents with a shell read as the same finding printed twice.
      title: `a shell surface makes everything the user can reach reachable from ${agentNameIn(entry.agentId)}`,
      agentIds: [entry.agentId],
      evidence: SURFACE_KIND.SHELL,
    }));
}

interface ExportPath {
  agentId: string;
  /** The three halves, named. A finding with no evidence is an opinion. */
  evidence: string[];
}

/**
 * The disk-shaped half of an export: what one agent holds at once, never whether it was
 * done in that order. `composition.ts` holds the tool-shaped half.
 */
function exportPaths(input: DoctorInput): ExportPath[] {
  return input.reachability.flatMap((entry) => {
    const found = exportPathOf(input, entry.agentId);
    return found === null ? [] : [found];
  });
}

function exportPathOf(input: DoctorInput, agentId: string): ExportPath | null {
  const sensitive = input.resources.find(
    (resource) =>
      resource.sensitivity !== SENSITIVITY.ORDINARY &&
      resource.reachableBy.some((ref) => ref.id === agentId),
  );
  const own = input.surfaces.filter((surface) => surface.agentId === agentId);
  const writes = own.find(
    (surface) =>
      surface.kind === SURFACE_KIND.FILESYSTEM || surface.kind === SURFACE_KIND.SHELL,
  );
  // A named tool that sends, because every agent with a shell has a network surface.
  const outward = own
    .flatMap((surface) => surface.tools ?? [])
    .find((tool) =>
      nameSegments(tool.name).some((part) => OUTWARD_TOOL_VERBS.includes(part)),
    );
  if (sensitive === undefined || writes === undefined || outward === undefined)
    return null;
  return {
    agentId,
    evidence: [
      `read ${sensitive.path ?? sensitive.id}`,
      `write via ${writes.kind}`,
      `send via ${outward.server}.${outward.name}`,
    ],
  };
}

/** The credentials to hand are the production ones while the work is local. */
function readsAsProduction(resource: Resource): boolean {
  const named = `${resource.id} ${resource.path ?? ''} ${resource.declaredIn ?? ''}`;
  return PRODUCTION_HINTS.some((hint) => named.toLowerCase().includes(hint));
}
