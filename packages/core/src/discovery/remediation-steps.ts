import {
  HARDEN_MODE,
  HARDEN_TARGET,
  RESOURCE_KIND,
  SURFACE_KIND,
  type ResourceKind,
  type SurfaceKind,
} from './discovery.constants';
import type { HardenStep } from './finding';
import { ENV_FILE_PATTERN } from './resource';

/**
 * The one change that closes each kind of finding, written as a rule file with its own
 * undo. Every step here is enforcing, because each one closes something unambiguous.
 */
const POLICY_DIR = 'policies';
/** Where the kernel profile is written, under the Memnox home. */
const GUARD_DIR = 'guard';

/** Why an ask rule exists, carried with it so two reasons never share one file. */
export interface AskReason {
  /** Slug for the rule and its file. */
  name: string;
  description: string;
  why: string;
}

/** Somebody may legitimately want a destructive tool, so the step asks rather than refuses. */
const ASK_DESTRUCTIVE: AskReason = {
  name: 'ask-destructive-tools',
  description: 'destructive tool call',
  why: 'A destructive tool call needs a person.',
};

/** An ordinary tool that is the step where data leaves the machine. */
export const ASK_CHAIN_EXIT: AskReason = {
  name: 'ask-tools-that-send-outward',
  description: 'tool call that takes data off this machine',
  why: 'Ordinary on its own, and the step where a read leaves the machine.',
};

interface PolicyStepInput {
  findingId: string;
  seam: SurfaceKind;
  description: string;
  file: string;
  contents: string;
}

function buildPolicyStep(input: PolicyStepInput): HardenStep {
  const id = `hs_${input.findingId}`;
  return {
    id,
    target: HARDEN_TARGET.POLICY,
    seam: input.seam,
    description: input.description,
    apply: {
      path: input.file,
      contents: input.contents,
      command: `memnox protect --apply ${id}`,
    },
    revert: { path: input.file, command: `memnox protect --revert ${id}` },
    mode: HARDEN_MODE.ENFORCE,
  };
}

/** Reaching production may be exactly right for one agent, so it asks rather than refuses. */
export function askProductionStep(findingId: string): HardenStep {
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
  return buildPolicyStep({
    findingId,
    seam: SURFACE_KIND.NETWORK,
    description: 'ask before anything touches production',
    file: `${POLICY_DIR}/ask-production.yaml`,
    contents,
  });
}

/**
 * The example conventionally beside a `.env` file. Nothing else gets a substitute,
 * because naming a path that is not there is worse than a refusal with none.
 */
function substituteFor(path: string, kind: ResourceKind): string | null {
  if (kind === RESOURCE_KIND.SOCKET) return null;
  return ENV_FILE_PATTERN.test(path) ? `${path}.example` : null;
}

/**
 * Every true name of one file: on macOS `/tmp/x` and `/private/tmp/x` are the same bytes,
 * and a rule naming one spelling is one the other walks past.
 */
export function spellingsOf(path: string): string[] {
  const spellings = new Set<string>([path]);
  if (path.startsWith('/private/')) spellings.add(path.slice('/private'.length));
  else if (path.startsWith('/tmp/') || path.startsWith('/var/'))
    spellings.add(`/private${path}`);
  return [...spellings];
}

/** Enforcing on a credential read is unambiguous, so this one arrives armed. */
export function denyReadStep(
  findingId: string,
  path: string,
  kind: ResourceKind,
): HardenStep {
  const substitute = substituteFor(path, kind);
  const targets = spellingsOf(path)
    .map((each) => `"${each}"`)
    .join(', ');
  const contents = [
    'version: 1',
    'policies:',
    `  - name: deny-${slug(path)}`,
    '    match:',
    '      actions: ["filesystem.read"]',
    `      targets: [${targets}]`,
    '    decision:',
    '      effect: deny',
    `      reason: "${path} holds a credential this task did not declare a need for."`,
    ...(substitute === null ? [] : alternativeLines(substitute)),
    '',
  ].join('\n');
  return buildPolicyStep({
    findingId,
    seam: SURFACE_KIND.FILESYSTEM,
    description:
      substitute === null
        ? `deny reads of ${path}`
        : `deny reads of ${path}, naming ${substitute} instead`,
    file: `${POLICY_DIR}/deny-${slug(path)}.yaml`,
    contents,
  });
}

function alternativeLines(substitute: string): string[] {
  return [
    '      alternative:',
    '        action: filesystem.read',
    `        resource: "${substitute}"`,
    `        note: "${substitute} is readable."`,
  ];
}

/**
 * What is left once the deny is written: a process calling `open(2)` directly meets no
 * seam, so the kernel profile, written from every filesystem rule at once, reaches it.
 */
export function osGuardStep(findingId: string): HardenStep {
  return {
    id: `hs_${findingId}`,
    target: HARDEN_TARGET.POLICY,
    seam: SURFACE_KIND.FILESYSTEM,
    description:
      'write the kernel sandbox profile, so a process that skips the seams is stopped too',
    // The directory, because the profile's file name differs between macOS and Linux.
    apply: { path: GUARD_DIR, command: 'memnox protect --os-guard --apply' },
    revert: { path: GUARD_DIR, command: 'memnox protect --revert' },
    mode: HARDEN_MODE.ENFORCE,
  };
}

export function askToolStep(
  findingId: string,
  tools: readonly string[],
  reason: AskReason = ASK_DESTRUCTIVE,
): HardenStep {
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
  const plural = tools.length === 1 ? '' : 's';
  return buildPolicyStep({
    findingId,
    seam: SURFACE_KIND.MCP,
    description: `ask before ${tools.length} ${reason.description}${plural}`,
    file: `${POLICY_DIR}/${reason.name}.yaml`,
    contents,
  });
}

function slug(path: string): string {
  return path
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}
