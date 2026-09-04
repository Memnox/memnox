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
  const lowered = name.toLowerCase();
  if (DESTRUCTIVE_VERBS.some((verb) => lowered.includes(verb)))
    return TOOL_EFFECT.DESTRUCTIVE;
  if (WRITE_VERBS.some((verb) => lowered.includes(verb))) return TOOL_EFFECT.WRITE;
  if (READ_VERBS.some((verb) => lowered.includes(verb))) return TOOL_EFFECT.READ;
  return null;
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
