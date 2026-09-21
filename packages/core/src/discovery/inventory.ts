import { RESOURCE_KIND, SENSITIVITY } from './discovery.constants';
import { classifyTool, TOOL_CLASS, type ToolClass, type ToolOverrides } from './classify';
import { CHAIN_LINK } from './composition';
import { distinctTools } from './surface';
import type { DiscoveryReport } from './discover';
import { OUTBOUND_STATE, type NetworkProbe } from './network';

/**
 * The scan's answer in one flat shape that leaves the process: what can act here and
 * what each thing reaches, as names, counts and fingerprints only.
 */
export const INVENTORY_VERSION = 2;

export interface InventoryAgent {
  id: string;
  kind: string;
  version?: string;
  /** The files that proved it. A detection with no evidence is a guess. */
  configPaths: string[];
  clients: string[];
}

export interface InventoryServer {
  name: string;
  /** The config that launches it, which answers "who granted this". */
  declaredIn: string;
  command: string;
  /** Credential names this config hands the server. Names only, never values. */
  credentials: string[];
  /** Agents that launch it, and so reach every tool it holds. */
  reachedBy: string[];
  /** True when nothing started it, so a tool count of zero means unknown. */
  unprobed: boolean;
}

export interface InventoryTool {
  server: string;
  name: string;
  class: ToolClass;
  /** How the class was decided, so a wrong call is arguable. */
  from: string;
}

export interface InventoryPath {
  path: string;
  sensitivity: string;
  /** Agent ids that reach it. Empty means nothing here can. */
  reachableBy: string[];
  /** A hash of the value, never the value. */
  fingerprint?: string;
}

export interface InventoryCredential {
  /** The variable or key name. What is stored is a name and a fingerprint. */
  name: string;
  declaredIn: string;
  reachableBy: string[];
}

export interface InventoryBinary {
  name: string;
  detectedFrom: string;
}

/** An agent that runs other agents: one row on the roster, several at the seam. */
export interface InventoryHarness {
  agentId: string;
  kind: string;
  /** Agent kinds it drives, as its own config named them. */
  runtimes: string[];
  /** Roles it defines on disk. Each is a separate principal. */
  roles: string[];
  /** Files it installed into another product's directory. */
  hooks: string[];
  federated: boolean;
  evidence: string[];
}

/** A path a set of tools opens that none of them opens alone. */
export interface InventoryChain {
  agentId: string;
  subject: string;
  consequence: string;
  steps: { link: string; server: string; tool: string }[];
  individuallyHarmless: boolean;
}

export interface CapabilityInventory {
  version: number;
  takenAt: string;
  agents: InventoryAgent[];
  mcpServers: InventoryServer[];
  tools: InventoryTool[];
  filesystem: InventoryPath[];
  /** Agent ids holding a shell, which reaches everything the user can. */
  shell: string[];
  git: InventoryBinary[];
  credentials: InventoryCredential[];
  network: NetworkProbe;
  harnesses: InventoryHarness[];
  /** Flat, so a consumer never has to walk a nesting to count the chains. */
  chains: InventoryChain[];
}

const GIT_BINARIES = ['git', 'gh'];

export function inventoryOf(
  report: DiscoveryReport,
  takenAt: string,
  overrides: ToolOverrides = {},
): CapabilityInventory {
  return {
    version: INVENTORY_VERSION,
    takenAt,
    agents: report.agents.map((agent) => ({
      id: agent.id,
      kind: agent.kind,
      ...(agent.version === undefined ? {} : { version: agent.version }),
      configPaths: [...agent.configPaths],
      clients: [...agent.clients],
    })),
    mcpServers: serversOf(report),
    tools: toolsOf(report, overrides),
    filesystem: pathsOf(report),
    shell: report.reachability
      .filter((entry) => entry.viaShell)
      .map((entry) => entry.agentId),
    git: report.tools.filter((tool) => GIT_BINARIES.includes(tool.name)),
    credentials: credentialsOf(report),
    network: report.egress,
    harnesses: report.harnesses.map((harness) => ({
      agentId: harness.agentId,
      kind: harness.kind,
      runtimes: [...harness.runtimes],
      roles: [...harness.roles],
      hooks: [...harness.hooks],
      federated: harness.federated,
      evidence: [...harness.evidence],
    })),
    chains: chainsOf(report),
  };
}

/** One row per server, not per client: one server in five editors is reached by five agents. */
function serversOf(report: DiscoveryReport): InventoryServer[] {
  const byName = new Map<string, InventoryServer>();
  for (const surface of report.surfaces) {
    for (const server of surface.servers ?? []) {
      const held = byName.get(server.name);
      if (held === undefined) {
        byName.set(server.name, {
          name: server.name,
          declaredIn: surface.detectedFrom,
          command: [server.command, ...server.args].join(' '),
          credentials: [...(server.env ?? [])],
          reachedBy: [surface.agentId],
          unprobed: !isProbed(report, server.name),
        });
      } else if (!held.reachedBy.includes(surface.agentId)) {
        held.reachedBy.push(surface.agentId);
      }
    }
  }
  return [...byName.values()];
}

function isProbed(report: DiscoveryReport, serverName: string): boolean {
  return report.surfaces.some((surface) =>
    (surface.tools ?? []).some((tool) => tool.server === serverName),
  );
}

function toolsOf(report: DiscoveryReport, overrides: ToolOverrides): InventoryTool[] {
  return distinctTools(report.surfaces).map((tool) => {
    const classification = classifyTool({ name: tool.name }, overrides);
    return {
      server: tool.server,
      name: tool.name,
      class: classification.class,
      from: classification.from,
    };
  });
}

function pathsOf(report: DiscoveryReport): InventoryPath[] {
  return report.resources.flatMap((resource) =>
    resource.path === undefined
      ? []
      : [
          {
            path: resource.path,
            sensitivity: resource.sensitivity,
            reachableBy: resource.reachableBy.map((ref) => ref.id),
            ...(resource.fingerprint === undefined
              ? {}
              : { fingerprint: resource.fingerprint }),
          },
        ],
  );
}

function credentialsOf(report: DiscoveryReport): InventoryCredential[] {
  return report.resources
    .filter((resource) => resource.kind === RESOURCE_KIND.SECRET)
    .map((resource) => ({
      name: resource.path ?? resource.id,
      declaredIn: resource.declaredIn ?? resource.path ?? 'unknown',
      reachableBy: resource.reachableBy.map((ref) => ref.id),
    }));
}

/** Flat, so a consumer never has to walk a nesting to count the chains. */
function chainsOf(report: DiscoveryReport): InventoryChain[] {
  return report.combined.flatMap((each) =>
    each.capabilities.map((capability) => ({
      agentId: each.agentId,
      subject: capability.subject,
      consequence: capability.consequence,
      steps: capability.steps.map((step) => ({ ...step })),
      individuallyHarmless: capability.individuallyHarmless,
    })),
  );
}

/**
 * Published so a consumer can validate an inventory it did not produce. A literal, since
 * one derived from the types at runtime would drift silently when they changed.
 */
export const CAPABILITY_INVENTORY_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://memnox.dev/schema/capability-inventory-v2.json',
  title: 'CapabilityInventory',
  type: 'object',
  required: [
    'version',
    'takenAt',
    'agents',
    'mcpServers',
    'tools',
    'filesystem',
    'shell',
    'git',
    'credentials',
    'network',
    'harnesses',
    'chains',
  ],
  additionalProperties: false,
  properties: {
    version: { type: 'integer', const: INVENTORY_VERSION },
    takenAt: { type: 'string' },
    agents: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'kind', 'configPaths', 'clients'],
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          kind: { type: 'string' },
          version: { type: 'string' },
          configPaths: { type: 'array', items: { type: 'string' } },
          clients: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    mcpServers: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'name',
          'declaredIn',
          'command',
          'credentials',
          'reachedBy',
          'unprobed',
        ],
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          declaredIn: { type: 'string' },
          command: { type: 'string' },
          credentials: { type: 'array', items: { type: 'string' } },
          reachedBy: { type: 'array', items: { type: 'string' } },
          unprobed: { type: 'boolean' },
        },
      },
    },
    tools: {
      type: 'array',
      items: {
        type: 'object',
        required: ['server', 'name', 'class', 'from'],
        additionalProperties: false,
        properties: {
          server: { type: 'string' },
          name: { type: 'string' },
          class: { enum: Object.values(TOOL_CLASS) },
          from: { type: 'string' },
        },
      },
    },
    filesystem: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'sensitivity', 'reachableBy'],
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          sensitivity: {
            enum: Object.values(SENSITIVITY),
          },
          reachableBy: { type: 'array', items: { type: 'string' } },
          fingerprint: { type: 'string' },
        },
      },
    },
    shell: { type: 'array', items: { type: 'string' } },
    git: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'detectedFrom'],
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          detectedFrom: { type: 'string' },
        },
      },
    },
    credentials: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'declaredIn', 'reachableBy'],
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          declaredIn: { type: 'string' },
          reachableBy: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    network: {
      type: 'object',
      required: ['outbound', 'proxyVars', 'noProxy', 'sandbox', 'read'],
      additionalProperties: false,
      properties: {
        outbound: { enum: Object.values(OUTBOUND_STATE) },
        proxyVars: { type: 'array', items: { type: 'string' } },
        noProxy: { type: 'array', items: { type: 'string' } },
        sandbox: { type: 'array', items: { type: 'string' } },
        read: { type: 'array', items: { type: 'string' } },
      },
    },
    harnesses: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'agentId',
          'kind',
          'runtimes',
          'roles',
          'hooks',
          'federated',
          'evidence',
        ],
        additionalProperties: false,
        properties: {
          agentId: { type: 'string' },
          kind: { type: 'string' },
          runtimes: { type: 'array', items: { type: 'string' } },
          roles: { type: 'array', items: { type: 'string' } },
          hooks: { type: 'array', items: { type: 'string' } },
          federated: { type: 'boolean' },
          evidence: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    chains: {
      type: 'array',
      items: {
        type: 'object',
        required: ['agentId', 'subject', 'consequence', 'steps', 'individuallyHarmless'],
        additionalProperties: false,
        properties: {
          agentId: { type: 'string' },
          subject: { type: 'string' },
          consequence: { type: 'string' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              required: ['link', 'server', 'tool'],
              additionalProperties: false,
              properties: {
                link: { enum: Object.values(CHAIN_LINK) },
                server: { type: 'string' },
                tool: { type: 'string' },
              },
            },
          },
          individuallyHarmless: { type: 'boolean' },
        },
      },
    },
  },
} as const;
