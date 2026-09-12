import { randomUUID } from 'node:crypto';
import type { Reachability } from './reachability';
import type { Resource } from './resource';
import { RESOURCE_KIND, type ResourceKind } from './discovery.constants';
import type { Surface } from './surface';
import { describeCombined, type AgentChains } from './composition';
import {
  agentIdsOf,
  rankFindings,
  severityOfResource,
  type Finding,
  type HardenStep,
} from './finding';
import {
  FINDING_KIND,
  FINDING_SEVERITY,
  HARDEN_MODE,
  HARDEN_TARGET,
  PRODUCTION_HINTS,
  SENSITIVITY,
  SURFACE_KIND,
  TOOL_EFFECT,
  type FindingSeverity,
  type SurfaceKind,
} from './discovery.constants';

/**
 * A decomposition of this machine's findings and nothing else. It grants nothing, it
 * changes no permission, and it is never a rank against anybody else's machine.
 */
/** Withholding by path closes a file. It closes nothing for a database or a network. */
const CLOSABLE_BY_PATH: readonly string[] = [
  RESOURCE_KIND.FILE,
  RESOURCE_KIND.SECRET,
  RESOURCE_KIND.REPO,
  RESOURCE_KIND.SOCKET,
];

/** Ordering only. Weights that summed into a total were how a score got built. */
const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  [FINDING_SEVERITY.LOW]: 0,
  [FINDING_SEVERITY.MEDIUM]: 1,
  [FINDING_SEVERITY.HIGH]: 2,
  [FINDING_SEVERITY.CRITICAL]: 3,
};

export interface DoctorInput {
  resources: readonly Resource[];
  reachability: readonly Reachability[];
  surfaces: readonly Surface[];
  /** Tool chains from the scan. Absent when nothing asked the servers what they hold. */
  chains?: readonly AgentChains[];
  /**
   * Whether a rule already denies reading a path, and which rule does.
   *
   * Without this the doctor reports what the scan can see and nothing else, so
   * running `memnox protect --apply` and then `memnox doctor` gave back the same
   * four criticals with the same `fix:` line the person had just applied. The
   * loop never closed: you did the work and the report could not tell you.
   *
   * A function rather than a list of paths, because the answer is the policy
   * engine's to give. A rule may name `~/.ssh/*` and cover a key it never
   * mentions, and re-deciding that here would be a second matcher that drifts
   * from the one the gate uses.
   *
   * Absent means nothing is known about rules, which is the honest reading for a
   * caller that did not load any: every finding then reads as ungoverned.
   */
  governedBy?: GovernedBy;
  /** Injected so a report is reproducible and a test is not a coin toss. */
  newId?: () => string;
}

/** Answers with the name of the rule that denies reading this path, or nothing. */
export type GovernedBy = (path: string) => string | undefined;

/**
 * One rung down, never to nothing.
 *
 * A rule covers the seams: the shell wrappers, the MCP proxy, the git hooks. It
 * does not cover a process that never meets one, and `SECURITY.md` is explicit
 * that `PATH` is advisory. So a governed credential is genuinely safer and is not
 * sealed, and reporting it as closed would be the one lie this command cannot
 * afford. The kernel guard is what closes the rest, which is why that is the
 * step offered next instead of the deny that is already written.
 */
const MITIGATED: Record<FindingSeverity, FindingSeverity> = {
  [FINDING_SEVERITY.CRITICAL]: FINDING_SEVERITY.MEDIUM,
  [FINDING_SEVERITY.HIGH]: FINDING_SEVERITY.MEDIUM,
  [FINDING_SEVERITY.MEDIUM]: FINDING_SEVERITY.LOW,
  [FINDING_SEVERITY.LOW]: FINDING_SEVERITY.LOW,
};

export interface DoctorReport {
  findings: Finding[];
  /** How many of each severity. A total would be a score, which is unarguable. */
  counts: SeverityCounts;
}

export type SeverityCounts = Record<FindingSeverity, number>;

/** Counted, never summed: three mediums are three mediums, not one high. */
export function countBySeverity(findings: readonly Finding[]): SeverityCounts {
  const counts: SeverityCounts = {
    [FINDING_SEVERITY.LOW]: 0,
    [FINDING_SEVERITY.MEDIUM]: 0,
    [FINDING_SEVERITY.HIGH]: 0,
    [FINDING_SEVERITY.CRITICAL]: 0,
  };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

/** Worst severity present, for ordering only. Absent means nothing was found. */
function worstOf(findings: readonly Finding[]): number {
  return findings.reduce(
    (worst, finding) => Math.max(worst, SEVERITY_ORDER[finding.severity]),
    -1,
  );
}

/**
 * Each finding names the agent, the resource, the evidence and the one change that
 * closes it. Nothing here estimates a loss, and nothing compares this machine to another.
 */
export function runDoctor(input: DoctorInput): DoctorReport {
  const newId = input.newId ?? randomUUID;
  /* Nothing known about rules reads as nothing governed, which is the honest
     answer for a caller that loaded none rather than a claim that none exist. */
  const governedBy = input.governedBy ?? ((): undefined => undefined);
  const findings: Finding[] = [];

  for (const resource of input.resources) {
    if (resource.sensitivity === SENSITIVITY.ORDINARY) continue;
    if (resource.reachableBy.length === 0) continue;
    const path = resource.path ?? resource.id;
    const id = newId();
    /* A file can be denied by path. A database an env file names, or the network
       itself, cannot: a `filesystem.read` rule against "postgres production URL"
       matches nothing, and offering it would be a fix that closes no finding. */
    const closable = CLOSABLE_BY_PATH.includes(resource.kind);
    /* Asked only where a rule could have been written. Nothing denies reads of
       "the network", so reporting it as ungoverned is not a gap in the rules. */
    const rule = closable ? governedBy(path) : undefined;
    const severity = severityOfResource(resource);
    findings.push({
      id,
      kind: FINDING_KIND.SENSITIVE_RESOURCE_REACHABLE,
      severity: rule === undefined ? severity : MITIGATED[severity],
      title:
        rule !== undefined
          ? `${path} is readable by ${resource.reachableBy.length} agent(s), and "${rule}" denies it at the seams`
          : closable
            ? `${path} is readable by ${resource.reachableBy.length} agent(s)`
            : `${path} is reachable by ${resource.reachableBy.length} agent(s), and a person decides what to do about it`,
      agentIds: agentIdsOf(resource.reachableBy),
      resourceId: resource.id,
      evidence: resource.declaredIn ?? path,
      /* The deny is written, so offering it again is how a person stops reading
         this list. What is left is the process that never meets a seam, and the
         kernel guard is the only thing that closes that. */
      ...(rule !== undefined
        ? { remediation: osGuardStep(id) }
        : closable
          ? { remediation: denyReadStep(id, path, resource.kind) }
          : {}),
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

  for (const resource of input.resources) {
    if (!readsAsProduction(resource)) continue;
    if (resource.reachableBy.length === 0) continue;
    const id = newId();
    const name = resource.path ?? resource.id;
    findings.push({
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

  for (const combination of exportPaths(input)) {
    const id = newId();
    findings.push({
      id,
      kind: FINDING_KIND.EXPORT_PATH,
      severity: FINDING_SEVERITY.HIGH,
      title: `${combination.agentId.replace('agt_', '')} can read sensitive data, write files and send outward — together that is an export, and no single rule refuses it`,
      agentIds: [combination.agentId],
      evidence: combination.evidence.join(' + '),
    });
  }

  /* The same shape one level down, where the chain is named tools rather than the
     disk. Only the ones no single step would be refused for: the destructive ones
     already have a finding above, and printing them twice teaches nothing. */
  for (const { agentId, capabilities } of input.chains ?? []) {
    for (const chain of capabilities) {
      if (!chain.individuallyHarmless) continue;
      const id = newId();
      const emit = chain.steps[chain.steps.length - 1];
      findings.push({
        id,
        kind: FINDING_KIND.TOOL_CHAIN,
        severity: FINDING_SEVERITY.HIGH,
        title: `${agentId.replace('agt_', '')}: ${chain.consequence} — every tool in the path is ordinary on its own`,
        agentIds: [agentId],
        evidence: describeCombined(chain),
        /* Asking on the step that leaves the machine breaks the chain and costs the
           least: the reads either side of it are what the agent is there to do. */
        ...(emit === undefined
          ? {}
          : {
              remediation: askToolStep(
                id,
                [`${emit.server}.${emit.tool}`],
                ASK_CHAIN_EXIT,
              ),
            }),
      });
    }
  }

  const unrestricted = input.reachability.filter((entry) => entry.viaShell);
  for (const entry of unrestricted) {
    const id = newId();
    findings.push({
      id,
      kind: FINDING_KIND.SHELL_SURFACE,
      severity: FINDING_SEVERITY.MEDIUM,
      // Named, or two agents with a shell read as the same finding printed twice.
      title: `a shell surface makes everything the user can reach reachable from ${entry.agentId.replace('agt_', '')}`,
      agentIds: [entry.agentId],
      evidence: SURFACE_KIND.SHELL,
    });
  }

  const ranked = rankFindings(findings);
  return { findings: ranked, counts: countBySeverity(ranked) };
}

interface ExportPath {
  agentId: string;
  /** The three halves, named. A finding with no evidence is an opinion. */
  evidence: string[];
}

/** A tool that can address somebody outside this machine, whatever it calls itself. */
const OUTWARD_TOOL_VERBS: readonly string[] = [
  'send',
  'post',
  'publish',
  'notify',
  'mail',
];

/**
 * Read a secret off the disk. Write a file. Send it somewhere. Each is ordinary, each
 * is allowed, and no evaluator looking at a single action will ever see the third one
 * coming. This is the disk-shaped half; `composition.ts` holds the tool-shaped one,
 * where the whole chain is named tools on named servers.
 *
 * This is what a local runtime can honestly answer: what one agent holds *at once*.
 * Whether it was ever done in that sequence is the joined ledger's question.
 */
function exportPaths(input: DoctorInput): ExportPath[] {
  const combinations: ExportPath[] = [];

  for (const entry of input.reachability) {
    const sensitive = input.resources.find(
      (resource) =>
        resource.sensitivity !== SENSITIVITY.ORDINARY &&
        resource.reachableBy.some((ref) => ref.id === entry.agentId),
    );
    if (sensitive === undefined) continue;

    const own = input.surfaces.filter((surface) => surface.agentId === entry.agentId);
    const writes = own.find(
      (surface) =>
        surface.kind === SURFACE_KIND.FILESYSTEM || surface.kind === SURFACE_KIND.SHELL,
    );
    if (writes === undefined) continue;

    /* A named tool that sends, not merely a network surface: every agent with a shell
       has one of those, and a finding that fires for all of them teaches nothing. */
    const outward = own.flatMap((surface) =>
      (surface.tools ?? []).filter((tool) =>
        OUTWARD_TOOL_VERBS.some((verb) => tool.name.toLowerCase().includes(verb)),
      ),
    )[0];
    if (outward === undefined) continue;

    combinations.push({
      agentId: entry.agentId,
      evidence: [
        `read ${sensitive.path ?? sensitive.id}`,
        `write via ${writes.kind}`,
        `send via ${outward.server}.${outward.name}`,
      ],
    });
  }
  return combinations;
}

const POLICY_DIR = 'policies';
/** Where the kernel profile is written, under the Memnox home. */
const GUARD_DIR = 'guard';

/**
 * The credentials that were to hand were the production ones and the work is local.
 * Nobody has ever put those two facts next to each other, and this is the comparison
 * rather than a policy somebody has to sit down and write.
 */
function readsAsProduction(resource: Resource): boolean {
  const named = `${resource.id} ${resource.path ?? ''} ${resource.declaredIn ?? ''}`;
  return PRODUCTION_HINTS.some((hint) => named.toLowerCase().includes(hint));
}

/** Reaching production may be exactly right for one agent, so it asks rather than refuses. */
function askProductionStep(findingId: string): HardenStep {
  const file = `${POLICY_DIR}/ask-production.yaml`;
  const contents = [
    'version: 1',
    'policies:',
    '  - name: ask-production',
    '    match:',
    '      actions: ["*"]',
    '      environments: ["production"]',
    '    decision:',
    '      effect: ask',
    '      approvers: ["you"]',
    '      reason: "Local work reaching production is a question, not a refusal."',
    '',
  ].join('\n');
  return {
    id: `hs_${findingId}`,
    target: HARDEN_TARGET.POLICY,
    seam: SURFACE_KIND.NETWORK,
    description: 'ask before anything touches production',
    apply: { path: file, contents, command: `memnox protect --apply hs_${findingId}` },
    revert: { path: file, command: `memnox protect --revert hs_${findingId}` },
    mode: HARDEN_MODE.ENFORCE,
  };
}

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
/**
 * The same file has more than one true name: on macOS `/tmp/x` and `/private/tmp/x`
 * are the same bytes. A rule naming one spelling is one the other walks past, so both
 * are written. Derived from the path itself, never guessed.
 */
export function spellingsOf(path: string): string[] {
  const spellings = new Set<string>([path]);
  if (path.startsWith('/private/')) spellings.add(path.slice('/private'.length));
  else if (path.startsWith('/tmp/') || path.startsWith('/var/'))
    spellings.add(`/private${path}`);
  return [...spellings];
}

function denyReadStep(findingId: string, path: string, kind: ResourceKind): HardenStep {
  const file = `${POLICY_DIR}/deny-${slug(path)}.yaml`;
  const substitute = substituteFor(path, kind);
  const contents = [
    'version: 1',
    'policies:',
    `  - name: deny-${slug(path)}`,
    '    match:',
    '      actions: ["filesystem.read"]',
    `      targets: [${spellingsOf(path)
      .map((each) => `"${each}"`)
      .join(', ')}]`,
    '    decision:',
    '      effect: deny',
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
        ? `deny reads of ${path}`
        : `deny reads of ${path}, naming ${substitute} instead`,
    apply: { path: file, contents, command: `memnox protect --apply hs_${findingId}` },
    revert: { path: file, command: `memnox protect --revert hs_${findingId}` },
    mode: HARDEN_MODE.ENFORCE,
  };
}

/**
 * What is left once the deny is written.
 *
 * A rule is enforced at the seams, so it covers what goes through a wrapper, the
 * proxy or a hook. A process that calls `open(2)` directly meets none of them, and
 * the kernel profile is the only thing that reaches it. Offering the deny again
 * here is how a person learns to stop reading this list; offering the step that
 * actually closes the remainder is the point of saying anything at all.
 *
 * One step for the machine rather than one per path, because the profile is
 * written from every filesystem rule at once.
 */
function osGuardStep(findingId: string): HardenStep {
  return {
    id: `hs_${findingId}`,
    target: HARDEN_TARGET.POLICY,
    seam: SURFACE_KIND.FILESYSTEM,
    description:
      'write the kernel sandbox profile, so a process that skips the seams is stopped too',
    /* The directory rather than a filename: the profile is `memnox.sb` on macOS
       and `landlock.json` on Linux, and the command writes whichever this machine
       takes. Naming one of them here would be wrong on the other. */
    apply: { path: GUARD_DIR, command: 'memnox protect --os-guard --apply' },
    revert: { path: GUARD_DIR, command: 'memnox protect --revert' },
    mode: HARDEN_MODE.ENFORCE,
  };
}

/** Ambiguous by nature: somebody may legitimately want the tool, so it asks first. */
/**
 * Why the rule exists travels with it, because the two callers ask for different
 * reasons: one tool is destructive on its own, and the other is an ordinary tool that
 * happens to be the step where data leaves. A rule that called the second one
 * destructive would be wrong in the file somebody reads a year later.
 */
interface AskReason {
  /** Slug for the rule and its file, so two reasons never overwrite each other. */
  name: string;
  description: string;
  why: string;
}

const ASK_DESTRUCTIVE: AskReason = {
  name: 'ask-destructive-tools',
  description: 'destructive tool call',
  why: 'A destructive tool call needs a person.',
};

const ASK_CHAIN_EXIT: AskReason = {
  name: 'ask-tools-that-send-outward',
  description: 'tool call that takes data off this machine',
  why: 'Ordinary on its own, and the step where a read leaves the machine.',
};

function askToolStep(
  findingId: string,
  tools: readonly string[],
  reason: AskReason = ASK_DESTRUCTIVE,
): HardenStep {
  const file = `${POLICY_DIR}/${reason.name}.yaml`;
  const contents = [
    'version: 1',
    'policies:',
    `  - name: ${reason.name}`,
    '    match:',
    `      actions: [${tools.map((tool) => `"mcp.${tool}"`).join(', ')}]`,
    '    decision:',
    '      effect: ask',
    '      approvers: ["you"]',
    `      reason: "${reason.why}"`,
    '',
  ].join('\n');
  return {
    id: `hs_${findingId}`,
    target: HARDEN_TARGET.POLICY,
    seam: SURFACE_KIND.MCP,
    description: `ask before ${tools.length} ${reason.description}${tools.length === 1 ? '' : 's'}`,
    apply: { path: file, contents, command: `memnox protect --apply hs_${findingId}` },
    revert: { path: file, command: `memnox protect --revert hs_${findingId}` },
    mode: HARDEN_MODE.ENFORCE,
  };
}

function slug(path: string): string {
  return path
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/** One agent on this machine, decomposed into what produced its findings. */
export interface AgentStanding {
  agentId: string;
  findings: number;
  /** The list underneath the count, so the ranking can be argued with. */
  bySeverity: Record<FindingSeverity, number>;
  /** Tools it reaches that change external state, write and destructive. */
  externalWriteTools: number;
  /** Named rather than counted: "messaging" is the fact somebody acts on. */
  surfaces: SurfaceKind[];
}

/**
 * Five agents evaluated on five different days by whoever installed them, put side by
 * side at last — ranked by what is configured *here*.
 *
 * It is never a safety rating of the products themselves. A league table of vendors
 * would be a claim about software nobody tested, and it is a comparison score by
 * another name.
 */
export function rankAgents(
  findings: readonly Finding[],
  surfaces: readonly Surface[],
): AgentStanding[] {
  const agentIds = new Set([
    ...findings.flatMap((finding) => finding.agentIds),
    ...surfaces.map((surface) => surface.agentId),
  ]);

  const standings = [...agentIds].map((agentId) => {
    const own = findings.filter((finding) => finding.agentIds.includes(agentId));
    const ownSurfaces = surfaces.filter((surface) => surface.agentId === agentId);
    return {
      agentId,
      findings: own.length,
      bySeverity: tally(own),
      externalWriteTools: ownSurfaces.reduce(
        (total, surface) =>
          total +
          (surface.tools ?? []).filter(
            (tool) =>
              tool.effect === TOOL_EFFECT.WRITE ||
              tool.effect === TOOL_EFFECT.DESTRUCTIVE,
          ).length,
        0,
      ),
      surfaces: [...new Set(ownSurfaces.map((surface) => surface.kind))].sort(),
    };
  });

  // Worst finding first, then how many of it. Never a total, which nobody can argue with.
  const forAgent = (id: string): Finding[] =>
    findings.filter((finding) => finding.agentIds.includes(id));
  return standings.sort((a, b) => {
    const worst = worstOf(forAgent(b.agentId)) - worstOf(forAgent(a.agentId));
    if (worst !== 0) return worst;
    const many = forAgent(b.agentId).length - forAgent(a.agentId).length;
    return many !== 0 ? many : a.agentId.localeCompare(b.agentId);
  });
}

function tally(findings: readonly Finding[]): Record<FindingSeverity, number> {
  const counts: Record<FindingSeverity, number> = {
    [FINDING_SEVERITY.LOW]: 0,
    [FINDING_SEVERITY.MEDIUM]: 0,
    [FINDING_SEVERITY.HIGH]: 0,
    [FINDING_SEVERITY.CRITICAL]: 0,
  };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}
