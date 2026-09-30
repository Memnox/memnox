import { AGENT_FLAG } from '@memnox/core';

/** Everything before `--` is ours; everything after is the wrapped server's. */
const COMMAND_SEPARATOR = '--';
const NAME_FLAG = '--name';
const DEFAULT_SERVER_NAME = 'mcp-server';
const FLAG_PREFIX = '--';

export interface FirewallArgs {
  /** The wrapped MCP server command, e.g. ["npx", "-y", "@some/mcp-server"]. */
  command: string[];
  serverName: string;
  /** Absent on a line wrapped before the agent was written into it. */
  agent?: string;
}

/** A flag that takes a value was given none, so the caller names it rather than guessing. */
interface MissingFlagValue {
  missingValueFor: string;
}

/** The value after `flag`, undefined when absent, or the flag itself when its value is missing. */
function flagValue(
  flags: readonly string[],
  flag: string,
): { value: string | undefined } | MissingFlagValue {
  const index = flags.indexOf(flag);
  if (index === -1) return { value: undefined };
  const value = flags[index + 1];
  // A value that looks like a flag is the next flag, and taking it would misread everything after.
  if (value === undefined || value.startsWith(FLAG_PREFIX))
    return { missingValueFor: flag };
  return { value };
}

/** Null means the invocation cannot run and the caller should print usage. */
export function parseFirewallArgs(
  argv: readonly string[],
): FirewallArgs | MissingFlagValue | null {
  const separator = argv.indexOf(COMMAND_SEPARATOR);
  if (separator === -1 || separator === argv.length - 1) return null;

  const flags = argv.slice(0, separator);
  const name = flagValue(flags, NAME_FLAG);
  if ('missingValueFor' in name) return name;
  const agentFlag = flagValue(flags, AGENT_FLAG);
  if ('missingValueFor' in agentFlag) return agentFlag;
  const agent = agentFlag.value;

  return {
    ...(agent === undefined || agent === '' ? {} : { agent }),
    command: argv.slice(separator + 1),
    serverName: name.value ?? DEFAULT_SERVER_NAME,
  };
}
