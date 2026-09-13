import { ConsoleOutput, type CliOutput } from './cli-output';
import { Flow } from './flow';
import { resolveStyle, type Style } from './style';

/** Everything a command needs from outside itself, so nothing reaches for `console`. */
export class CliContext {
  /**
   * The one rail this run draws on.
   *
   * Held here rather than built per command, because there is exactly one run
   * and a second `Flow` would be a second rail: two headers, two closing
   * lines, and a helper that draws on one while its caller draws on the other.
   * A command opens it with the name a person typed, and everything below
   * draws on the same one without being handed it, including the modules under
   * `scan/`, `protect/` and `sync/` that do the actual reporting.
   */
  readonly flow: Flow;

  constructor(
    readonly out: CliOutput = new ConsoleOutput(),
    readonly style: Style = resolveStyle(process.env, process.stdout.isTTY === true),
  ) {
    this.flow = new Flow(out, style);
  }
}
