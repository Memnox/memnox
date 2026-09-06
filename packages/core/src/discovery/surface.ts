import {
  EFFECT_INFERENCE,
  TOOL_EFFECT,
  type EffectInference,
  type SurfaceKind,
  type ToolEffect,
} from './discovery.constants';

/** One tool on one server, with what it does and how that was decided. */
export interface McpTool {
  server: string;
  name: string;
  description?: string;
  effect: ToolEffect;
  inferredFrom: EffectInference;
}

export interface Surface {
  agentId: string;
  kind: SurfaceKind;
  /** The file that proved it. A surface with no evidence is a guess. */
  detectedFrom: string;
  tools?: McpTool[];
  /**
   * The launch lines a config declared. A config says what a server is called and
   * never what it can do, so these exist to be asked over the protocol.
   */
  servers?: McpServerLaunch[];
  /**
   * Tools the host's own filter takes away before the agent sees them. Counted rather
   * than dropped silently, because a client that already filters deserves the credit
   * and the reader deserves to know the number is smaller for a reason.
   */
  filteredOut?: number;
}

/** Enough to start one MCP server and ask it what it holds. */
export interface McpServerLaunch {
  name: string;
  command: string;
  args: string[];
  /**
   * The credential names this config hands the server. Names only: what is stored is
   * a key, never the value behind it.
   */
  env?: string[];
  /** An allow/deny list the host applies before the agent ever sees the tool. */
  filter?: ToolFilter;
  /** A server the config declares and has switched off. Present, and not reachable. */
  disabled?: boolean;
}

/**
 * Hermes writes `tools.include` / `tools.exclude`; OpenClaw writes `tools.allow` /
 * `tools.deny`. They look like the same control and they resolve the pair differently,
 * so the filter carries whose rules it is rather than one matcher guessing.
 *
 * Hermes, from its own source: a present `include` decides alone and `exclude` is not
 * consulted at all, and `include: []` registers nothing. OpenClaw denies first. Reading
 * one product's file with the other's precedence reports the wrong reachable set, which
 * is the whole thing a scan exists to get right.
 */
export const FILTER_PRECEDENCE = {
  /** A present include list decides alone. Hermes. */
  INCLUDE_WINS: 'include-wins',
  /** Deny is checked first, then any allow list. OpenClaw. */
  EXCLUDE_WINS: 'exclude-wins',
} as const;

export type FilterPrecedence = (typeof FILTER_PRECEDENCE)[keyof typeof FILTER_PRECEDENCE];

export interface ToolFilter {
  /** Absent means no whitelist. Empty means a whitelist that admits nothing. */
  include?: string[];
  exclude: string[];
  precedence: FilterPrecedence;
}

export function passesFilter(name: string, filter: ToolFilter | undefined): boolean {
  if (filter === undefined) return true;

  if (filter.precedence === FILTER_PRECEDENCE.INCLUDE_WINS) {
    // A whitelist that is present answers on its own, empty included.
    if (filter.include !== undefined) return matchesGlob(name, filter.include);
    return !matchesGlob(name, filter.exclude);
  }

  if (matchesGlob(name, filter.exclude)) return false;
  if (filter.include === undefined || filter.include.length === 0) return true;
  return matchesGlob(name, filter.include);
}

/**
 * Exact name first, then a case-sensitive glob — the semantics both products use.
 * The policy matcher lowercases, which is right for a rule somebody typed and wrong
 * for a tool name, where `readFile` and `readfile` are two different tools.
 */
function matchesGlob(name: string, patterns: readonly string[]): boolean {
  if (patterns.includes(name)) return true;
  return patterns.some(
    (pattern) => /[*?[]/.test(pattern) && globExpression(pattern).test(name),
  );
}

const globCache = new Map<string, RegExp>();

function globExpression(pattern: string): RegExp {
  const held = globCache.get(pattern);
  if (held !== undefined) return held;
  const source = pattern
    .split('')
    .map((char) => {
      if (char === '*') return '.*';
      if (char === '?') return '.';
      return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
    })
    .join('');
  const expression = new RegExp(`^${source}$`);
  globCache.set(pattern, expression);
  return expression;
}

/** The protocol's own annotation, when a server bothered to publish one. */
export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

export interface McpToolDeclaration {
  name: string;
  description?: string;
  annotations?: McpToolAnnotations;
  inputSchema?: { properties?: Record<string, unknown> };
}

const DESTRUCTIVE_VERBS = [
  'delete',
  'drop',
  'destroy',
  'remove',
  'purge',
  'truncate',
  'revoke',
];
const WRITE_VERBS = [
  'write',
  'create',
  'update',
  'modify',
  'edit',
  'add',
  'insert',
  'set',
  'post',
  'send',
  'merge',
  'push',
  'apply',
  'deploy',
  'upload',
  'publish',
  'rename',
];
const READ_VERBS = [
  'get',
  'read',
  'list',
  'search',
  'fetch',
  'find',
  'query',
  'describe',
];

/**
 * Effect is taken from the tool's own annotation where it exists and inferred with a
 * stated method where it does not, so a wrong call can be seen and corrected rather
 * than quietly changing what a rule covers.
 */
export function inferToolEffect(declaration: McpToolDeclaration): {
  effect: ToolEffect;
  inferredFrom: EffectInference;
} {
  const annotations = declaration.annotations;
  if (annotations !== undefined) {
    if (annotations.destructiveHint === true) {
      return {
        effect: TOOL_EFFECT.DESTRUCTIVE,
        inferredFrom: EFFECT_INFERENCE.ANNOTATION,
      };
    }
    if (annotations.readOnlyHint === true) {
      return { effect: TOOL_EFFECT.READ, inferredFrom: EFFECT_INFERENCE.ANNOTATION };
    }
    if (annotations.readOnlyHint === false) {
      return { effect: TOOL_EFFECT.WRITE, inferredFrom: EFFECT_INFERENCE.ANNOTATION };
    }
  }

  const named = effectOfName(declaration.name);
  if (named !== null) return { effect: named, inferredFrom: EFFECT_INFERENCE.NAME };

  // A tool taking no arguments cannot name a thing to change, so it reads at worst.
  const schema = declaration.inputSchema;
  const properties = schema === undefined ? undefined : schema.properties;
  if (properties !== undefined && Object.keys(properties).length === 0) {
    return { effect: TOOL_EFFECT.READ, inferredFrom: EFFECT_INFERENCE.SCHEMA };
  }

  return { effect: TOOL_EFFECT.UNKNOWN, inferredFrom: EFFECT_INFERENCE.NAME };
}

/**
 * The verb in a name, which is all a name carries. Exported because an action on the
 * wire is named the same way a tool is, and two verb lists would drift apart.
 */
export function effectOfName(name: string): ToolEffect | null {
  const segments = nameSegments(name);
  const has = (verbs: readonly string[]): boolean =>
    verbs.some((verb) => segments.includes(verb));

  if (has(DESTRUCTIVE_VERBS)) return TOOL_EFFECT.DESTRUCTIVE;
  if (has(WRITE_VERBS)) return TOOL_EFFECT.WRITE;
  if (has(READ_VERBS)) return TOOL_EFFECT.READ;
  return null;
}

/**
 * Split on separators and camel humps rather than matching substrings: "widget"
 * contains "get", and a tool called `frobnicate_widget` read as a read is exactly the
 * wrong kind of confident.
 */
export function nameSegments(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part !== '');
}

/**
 * One entry per tool, however many clients declare the server it lives on.
 *
 * The same `github` server is normally configured in several editors at once, and each
 * client's surface carries its own copy of that server's tools. Summing the surfaces
 * multiplies the count by the number of clients: four tools in five editors reported as
 * twenty, which inflates the tool count, the destructive count, the risk band and the
 * gap. A tool is a thing on a server, not a thing per client that reaches it.
 */
export function distinctTools(surfaces: readonly { tools?: McpTool[] }[]): McpTool[] {
  const seen = new Map<string, McpTool>();
  for (const surface of surfaces) {
    for (const tool of surface.tools ?? []) {
      const key = `${tool.server}\u0000${tool.name}`;
      if (!seen.has(key)) seen.set(key, tool);
    }
  }
  return [...seen.values()];
}

export function toMcpTool(server: string, declaration: McpToolDeclaration): McpTool {
  const { effect, inferredFrom } = inferToolEffect(declaration);
  return {
    server,
    name: declaration.name,
    ...(declaration.description === undefined
      ? {}
      : { description: declaration.description }),
    effect,
    inferredFrom,
  };
}
