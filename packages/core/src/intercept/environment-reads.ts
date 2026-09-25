/**
 * A command that prints a variable's value: `env`, `printenv`, `export -p`, or `echo $KEY`.
 * The value is never read here; the command is named, and so is the variable.
 */
import { ACTION, EVERY_VARIABLE } from '../constants/action.constants';
import { TOOL_CLASS } from '../discovery/classify';
import { looksLikeCredential } from '../discovery/credentials';
import type { ParsedCommand } from '../domain/shell-normalizer';

export interface EnvironmentRead {
  action: typeof ACTION.ENVIRONMENT_READ;
  class: typeof TOOL_CLASS.READ;
  because: string;
  target: string;
  targets: readonly string[];
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const EXPANSION = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;

/** Commands whose job is to put their arguments on the screen, where a model reads them. */
const PRINTERS = new Set(['echo', 'printf', 'print']);

/**
 * The variables a line prints, `all` for a dump, or none. A key handed to `curl` is used
 * rather than shown, and the egress check reads what a request carries.
 */
export function variablesPrinted(commands: readonly ParsedCommand[]): string[] {
  const named = new Set<string>();
  for (const command of commands) {
    for (const name of printedBy(command.argv)) named.add(name);
    if (!PRINTERS.has(command.argv[0]?.split('/').pop() ?? '')) continue;
    // Only a credential-like name counts, or every `echo $HOME` would be a read.
    for (const arg of command.argv.slice(1)) {
      for (const match of arg.matchAll(EXPANSION)) {
        const name = match[1] as string;
        if (looksLikeCredential(name)) named.add(name);
      }
    }
  }
  return [...named];
}

function printedBy(argv: readonly string[]): string[] {
  const [path, ...args] = argv;
  const binary = path?.split('/').pop();
  const operands = args.filter((arg) => !arg.startsWith('-'));
  // `env FOO=1 node x` runs a program; only a bare `env` prints.
  if (binary === 'env') {
    const program = operands.filter((arg) => !ASSIGNMENT.test(arg));
    return program.length === 0 ? [EVERY_VARIABLE] : [];
  }
  if (binary === 'printenv') return operands.length === 0 ? [EVERY_VARIABLE] : operands;
  const dumps = args.length === 0 || args.includes('-p');
  if ((binary === 'export' || binary === 'declare') && dumps) return [EVERY_VARIABLE];
  if (binary === 'set' && args.length === 0) return [EVERY_VARIABLE];
  return [];
}

export function environmentRead(names: readonly string[]): EnvironmentRead | null {
  const first = names[0];
  if (first === undefined) return null;
  return {
    action: ACTION.ENVIRONMENT_READ,
    class: TOOL_CLASS.READ,
    because:
      first === EVERY_VARIABLE
        ? 'it prints every variable, keys included'
        : `it prints the value of ${names.join(', ')}`,
    target: first,
    targets: names,
  };
}
