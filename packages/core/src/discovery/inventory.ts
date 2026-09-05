import { RESOURCE_KIND, SENSITIVITY } from './discovery.constants';
import { classifyTool, type ToolClass, type ToolOverrides } from './classify';
import type { DiscoveryReport } from './discover';
import type { NetworkProbe } from './network';

/**
 * The scan's answer in one flat shape: what can act here, and what each thing reaches.
 * `DiscoveryReport` is how the scan is assembled; this is what it means, and it is the
 * shape that leaves the process — so it carries names, counts and fingerprints only.
 */
export const INVENTORY_VERSION = 1;

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
}

const GIT_BINARIES = ['git', 'gh'];

export function inventoryOf(
  report: DiscoveryReport,
  takenAt: string,
  overrides: ToolOverrides = {},
): CapabilityInventory {
  const launches = report.surfaces.flatMap((surface) =>
    (surface.servers ?? []).map((server) => ({ surface, server })),
  );

  const servers: InventoryServer[] = launches.map(({ surface, server }) => {
    const tools = (surface.tools ?? []).filter((tool) => tool.server === server.name);
    return {
      name: server.name,
      declaredIn: surface.detectedFrom,
      command: [server.command, ...server.args].join(' '),
      credentials: [...(server.env ?? [])],
      reachedBy: launches
        .filter((each) => each.server.name === server.name)
        .map((each) => each.surface.agentId),
      unprobed: tools.length === 0,
    };
  });

  const tools: InventoryTool[] = report.surfaces.flatMap((surface) =>
    (surface.tools ?? []).map((tool) => {
      const classification = classifyTool({ name: tool.name }, overrides);
      return {
        server: tool.server,
        name: tool.name,
        class: classification.class,
        from: classification.from,
      };
    }),
  );

  const filesystem: InventoryPath[] = report.resources
    .filter((resource) => resource.path !== undefined)
    .map((resource) => ({
      path: resource.path as string,
      sensitivity: resource.sensitivity,
      reachableBy: resource.reachableBy.map((ref) => ref.id),
      ...(resource.fingerprint === undefined
        ? {}
        : { fingerprint: resource.fingerprint }),
    }));

  const credentials: InventoryCredential[] = report.resources
    .filter((resource) => resource.kind === RESOURCE_KIND.SECRET)
    .map((resource) => ({
      name: resource.path ?? resource.id,
      declaredIn: resource.declaredIn ?? resource.path ?? 'unknown',
      reachableBy: resource.reachableBy.map((ref) => ref.id),
    }));

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
    mcpServers: servers,
    tools,
    filesystem,
    shell: report.reachability
      .filter((entry) => entry.viaShell)
      .map((entry) => entry.agentId),
    git: report.tools.filter((tool) => GIT_BINARIES.includes(tool.name)),
    credentials,
    network: report.egress,
  };
}

/**
 * Published so a consumer can validate an inventory it did not produce. Kept as a
 * literal rather than generated: a schema derived from the types at runtime would
 * drift silently the moment the types changed shape.
 */
export const CAPABILITY_INVENTORY_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://memnox.dev/schema/capability-inventory-v1.json',
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
          class: {
            enum: ['read', 'write', 'destructive', 'communication', 'unknown'],
          },
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
            enum: [SENSITIVITY.ORDINARY, SENSITIVITY.SENSITIVE, SENSITIVITY.CRITICAL],
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
        outbound: { enum: ['detected', 'restricted', 'unknown'] },
        proxyVars: { type: 'array', items: { type: 'string' } },
        noProxy: { type: 'array', items: { type: 'string' } },
        sandbox: { type: 'array', items: { type: 'string' } },
        read: { type: 'array', items: { type: 'string' } },
      },
    },
  },
} as const;
