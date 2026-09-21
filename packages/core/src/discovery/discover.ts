import { join } from 'node:path';
import { agentRefOf, type AgentRef, type DiscoveredAgent } from './agent';
import { findBrowserAutomation, type BrowserFinding } from './browser';
import { chainsFor, type AgentChains } from './composition';
import {
  authenticatedClis,
  findCredentials,
  findEnvFiles,
  FINGERPRINTED_HOME_PATHS,
  PROJECT_CREDENTIAL_FILES,
  type AuthenticatedCli,
  type CredentialFinding,
  type EnvFinding,
} from './credentials';
import type { AgentDetector, DetectionContext } from './detectors/detector';
import { DEFAULT_DETECTORS } from './detectors/index';
import { SENSITIVITY, SURFACE_KIND } from './discovery.constants';
import { harnessOf, type Harness } from './harness';
import { probeNetwork, SANDBOX_PATHS, type NetworkProbe } from './network';
import type { MachineReader, McpLister } from './ports';
import {
  databasesIn,
  detectTools,
  networkReach,
  type DiscoveredTool,
} from './reach-detail';
import {
  attributeResources,
  computeReachability,
  type Reachability,
} from './reachability';
import {
  classifyResourceKind,
  classifySensitivity,
  fingerprint,
  type Resource,
} from './resource';
import { discoverDefinitions, type DiscoveredSkill } from './skills';
import {
  distinctTools,
  passesFilter,
  toMcpTool,
  type McpServerLaunch,
  type McpToolDeclaration,
  type Surface,
} from './surface';

/**
 * The whole scan, read off the disk: agents, what they act through, what they reach, and
 * the credentials under them. Nothing is transmitted, and nothing dials outward.
 */

/** Sockets an agent with a shell can drive, which is the whole host. */
const SOCKET_PATHS: readonly string[] = ['/var/run/docker.sock'];

/** A checkout is a resource in its own right: an agent with it can push. */
const REPOSITORY_MARKER = '.git';

export interface DiscoveryReport {
  agents: DiscoveredAgent[];
  surfaces: readonly Surface[];
  resources: Resource[];
  reachability: Reachability[];
  /** What was opened and why, so the tool that inspects credentials is itself inspectable. */
  read: string[];
  /** Servers this run started to ask what they hold, named for the same reason. */
  probed: string[];
  /** Command-line tools an agent with a shell can invoke, each with what proved it. */
  tools: DiscoveredTool[];
  /** What the environment says about reaching the network. Never measured by dialling. */
  egress: NetworkProbe;
  /** Credential files an agent here can read. Names and structure, never values. */
  credentials: CredentialFinding[];
  /** A binary plus a credential it can use: the pair is the finding. */
  authenticated: AuthenticatedCli[];
  /** Browser drivers, and whether they carry a profile that holds your logins. */
  browsers: BrowserFinding[];
  /** `.env` files in the directories worked in: counts of variables and key-like names. */
  envFiles: EnvFinding[];
  /** Agents that run other agents: one row on the roster and several principals at the seam. */
  harnesses: Harness[];
  /** Paths a set of tools opens that no single one does, per agent that can walk all of it. */
  combined: AgentChains[];
  /**
   * Skills and installed personas, each with the tool grant its own header states. Kept
   * out of `read`, where three hundred paths would bury the credentials.
   */
  definitions: DiscoveredSkill[];
}

export interface DiscoveryOptions {
  detectors?: readonly AgentDetector[];
  /** Supplied rather than read, so discovery stays a function of what it was given. */
  env?: NodeJS.ProcessEnv;
  /** Directories the reader works in, which hold the credentials a repository has. */
  projectDirs?: readonly string[];
  /** Injected so a report is reproducible; never read off a clock inside the run. */
  now: string;
  /**
   * Supplied, each server is started and asked what it holds, the only thing here that
   * runs somebody else's code. Omitted, every MCP surface reports no tools.
   */
  lister?: McpLister;
}

/**
 * The only aggregate true at minute zero. With a lister it starts the MCP servers this
 * machine already launches, and names each one it started.
 */
export async function discover(
  reader: MachineReader,
  options: DiscoveryOptions,
): Promise<DiscoveryReport> {
  const detected = await runDetectors(reader, options);
  const { surfaces, probed } = await probeServers(detected.surfaces, options.lister);
  const { resources, read } = await scanResources(reader, options.projectDirs ?? []);
  // Derived from the surfaces already found, never asserted on its own.
  const network = networkReach(surfaces);
  if (network !== null) resources.push(network);

  const { definitions, ...facts } = await readMachineFacts(reader, options);
  const refs: AgentRef[] = detected.agents.map(agentRefOf);
  const reachability = computeReachability(refs, surfaces, resources);
  return {
    agents: detected.agents,
    surfaces,
    resources: attributeResources(resources, reachability, refs),
    reachability,
    read: [...read, ...facts.egress.read, ...facts.credentials.map((each) => each.path)],
    probed,
    ...facts,
    harnesses: detected.harnesses,
    combined: chainsFor(
      detected.agents.map((agent) => agent.id),
      surfaces,
    ),
    definitions,
  };
}

/** What the machine holds under its agents: egress, binaries, credentials and definitions. */
type MachineFacts = Pick<
  DiscoveryReport,
  | 'egress'
  | 'tools'
  | 'credentials'
  | 'authenticated'
  | 'browsers'
  | 'envFiles'
  | 'definitions'
>;

async function readMachineFacts(
  reader: MachineReader,
  options: DiscoveryOptions,
): Promise<MachineFacts> {
  const projectDirs = options.projectDirs ?? [];
  const egress = probeNetwork({
    env: options.env ?? {},
    present: await sandboxMarkers(reader),
  });
  const tools = await detectTools(reader);
  const credentials = await findCredentials(reader);
  return {
    tools,
    egress,
    credentials,
    // A binary alone and a credential alone are unremarkable; the pair is the finding.
    authenticated: authenticatedClis(
      tools.map((tool) => tool.name),
      credentials,
      Object.keys(options.env ?? {}),
    ),
    browsers: await findBrowserAutomation(reader, projectDirs),
    envFiles: await findEnvFiles(reader, projectDirs),
    // The work as well as home: a definition in a repository is installed by cloning it.
    definitions: await discoverDefinitions(reader, [reader.homeDir(), ...projectDirs]),
  };
}

interface Detected {
  agents: DiscoveredAgent[];
  surfaces: Surface[];
  harnesses: Harness[];
}

async function runDetectors(
  reader: MachineReader,
  options: DiscoveryOptions,
): Promise<Detected> {
  const detected: Detected = { agents: [], surfaces: [], harnesses: [] };
  const context: DetectionContext = { projectDirs: options.projectDirs ?? [] };
  for (const detector of options.detectors ?? DEFAULT_DETECTORS) {
    const found = await detector.detect(reader, options.now, context);
    if (found === null) continue;
    detected.agents.push(found.agent);
    detected.surfaces.push(...found.surfaces);
    const harness = harnessOf(found.agent, found.hosted);
    if (harness !== null) detected.harnesses.push(harness);
  }
  return detected;
}

async function sandboxMarkers(reader: MachineReader): Promise<string[]> {
  const present: string[] = [];
  for (const path of SANDBOX_PATHS) {
    if (await reader.exists(path)) present.push(path);
  }
  return present;
}

/** One server's answer, still attached to the surface that declared it. */
interface ProbeOutcome {
  surface: Surface;
  server: McpServerLaunch;
  declared: McpToolDeclaration[];
}

/**
 * Every server asked what it holds, in parallel because each handshake carries its own
 * timeout. One that will not start loses its own tools and nobody else's.
 */
async function probeServers(
  surfaces: readonly Surface[],
  lister: McpLister | undefined,
): Promise<{ surfaces: Surface[]; probed: string[] }> {
  if (lister === undefined) return { surfaces: [...surfaces], probed: [] };

  const outcomes = await Promise.all(
    surfaces.flatMap((surface) =>
      // A disabled server is declared and not running, so starting it would invent reach.
      (surface.servers ?? [])
        .filter((server) => server.disabled !== true)
        .map((server) => probeOne(lister, surface, server)),
    ),
  );
  return {
    surfaces: surfaces.map((surface) =>
      withProbedTools(
        surface,
        outcomes.filter((outcome) => outcome.surface === surface),
      ),
    ),
    // Named so the probe is itself inspectable.
    probed: outcomes.map(
      ({ server }) => `${server.name}: ${[server.command, ...server.args].join(' ')}`,
    ),
  };
}

async function probeOne(
  lister: McpLister,
  surface: Surface,
  server: McpServerLaunch,
): Promise<ProbeOutcome> {
  try {
    const declared = await lister.listTools(server.name, server.command, server.args);
    return { surface, server, declared };
  } catch {
    // A gap in the report, never a crash: zero tools here means unknown.
    return { surface, server, declared: [] };
  }
}

/**
 * A surface with the tools its servers declared. A tool the host's own filter takes
 * away is not reachable through it, so it is counted in `filteredOut` rather than kept.
 */
function withProbedTools(surface: Surface, outcomes: readonly ProbeOutcome[]): Surface {
  if (outcomes.length === 0) return surface;
  const tools = [...(surface.tools ?? [])];
  let filteredOut = surface.filteredOut;
  for (const { server, declared } of outcomes) {
    for (const declaration of declared) {
      if (passesFilter(declaration.name, server.filter)) {
        tools.push(toMcpTool(server.name, declaration));
      } else {
        filteredOut = (filteredOut ?? 0) + 1;
      }
    }
  }
  return { ...surface, tools, ...(filteredOut === undefined ? {} : { filteredOut }) };
}

/**
 * Finding a credential requires reading the file it lives in. The value stays in this
 * function: what leaves is a path, a kind and a hash.
 */
async function scanResources(
  reader: MachineReader,
  projectDirs: readonly string[],
): Promise<{ resources: Resource[]; read: string[] }> {
  const scan: ResourceScan = { resources: [], read: [], seen: new Set<string>() };
  const home = reader.homeDir();
  for (const relative of FINGERPRINTED_HOME_PATHS) {
    await recordFile(reader, scan, join(home, relative));
  }
  for (const dir of projectDirs) {
    for (const file of PROJECT_CREDENTIAL_FILES)
      await recordFile(reader, scan, join(dir, file));
    await recordRepository(reader, scan, join(dir, REPOSITORY_MARKER));
  }
  for (const path of SOCKET_PATHS) {
    if (!(await reader.exists(path))) continue;
    scan.resources.push({
      id: `res_${fingerprint(path)}`,
      kind: classifyResourceKind(path),
      path,
      sensitivity: SENSITIVITY.CRITICAL,
      reachableBy: [],
    });
  }
  return { resources: scan.resources, read: scan.read };
}

interface ResourceScan {
  resources: Resource[];
  read: string[];
  seen: Set<string>;
}

/** A readable file, fingerprinted, plus any database its contents name by scheme. */
async function recordFile(
  reader: MachineReader,
  scan: ResourceScan,
  path: string,
): Promise<void> {
  if (scan.seen.has(path)) return;
  const contents = await reader.read(path);
  if (contents === null) return;
  scan.seen.add(path);
  scan.read.push(path);
  scan.resources.push({
    id: `res_${fingerprint(path)}`,
    kind: classifyResourceKind(path),
    path,
    fingerprint: fingerprint(contents),
    sensitivity: classifySensitivity(path),
    reachableBy: [],
  });
  scan.resources.push(...databasesIn(contents, path));
}

/** A checkout is reachable in its own right, and it is not opened to be counted. */
async function recordRepository(
  reader: MachineReader,
  scan: ResourceScan,
  repository: string,
): Promise<void> {
  if (!(await reader.exists(repository)) || scan.seen.has(repository)) return;
  scan.seen.add(repository);
  scan.resources.push({
    id: `res_${fingerprint(repository)}`,
    kind: classifyResourceKind(repository),
    path: repository,
    sensitivity: classifySensitivity(repository),
    reachableBy: [],
  });
}

/** Counts and names, not percentages: a percentage here has no denominator. */
export function summarize(report: DiscoveryReport): {
  agents: number;
  surfaces: number;
  tools: number;
  reachableSecrets: number;
} {
  const tools = distinctTools(report.surfaces).length;
  const reachableSecrets = report.resources.filter(
    (resource) =>
      resource.sensitivity !== SENSITIVITY.ORDINARY && resource.reachableBy.length > 0,
  ).length;
  return {
    agents: report.agents.length,
    surfaces: report.surfaces.filter((surface) => surface.kind !== SURFACE_KIND.MCP)
      .length,
    tools,
    reachableSecrets,
  };
}
