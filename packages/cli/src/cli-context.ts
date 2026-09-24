import { ConsoleOutput, type CliOutput } from './cli-output';
import { Flow } from './flow';
import { resolveStyle, type Style } from './style';

/** Everything a command needs from outside itself, so nothing reaches for `console`. */
export class CliContext {
  /** The one rail this run draws on, held here because a second `Flow` is a second header. */
  readonly flow: Flow;

  constructor(
    readonly out: CliOutput = new ConsoleOutput(),
    readonly style: Style = resolveStyle(process.env, process.stdout.isTTY === true),
  ) {
    this.flow = new Flow(out, style);
  }
}
