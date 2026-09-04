import { ConsoleOutput, type CliOutput } from './cli-output';
import { resolveStyle, type Style } from './style';

/** Everything a command needs from outside itself, so nothing reaches for `console`. */
export class CliContext {
  constructor(
    readonly out: CliOutput = new ConsoleOutput(),
    readonly style: Style = resolveStyle(process.env, process.stdout.isTTY === true),
  ) {}
}
