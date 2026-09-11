import type { CliOutput } from './cli-output';
import type { Style } from './style';

/**
 * A command that reports its steps as it takes them.
 *
 * One vertical rail down the left, a marker at each step, and the value under
 * its label rather than beside it — so a long path or a list of names wraps
 * into the gutter instead of pushing the next column off the screen. `login`
 * and `sync` are the shape this is for: several things happen in order, each
 * one is worth seeing, and the last one is the answer.
 *
 * **All of it is commentary.** Every line here goes to `note`, which is stderr,
 * because a rail is decoration and a caller piping this CLI must receive the
 * payload and nothing else. A command with a machine-readable answer still
 * prints it with `line`, and `--json` bypasses this entirely.
 *
 * In plain mode the rail is dropped rather than drawn in ASCII. A vertical bar
 * on every line of a log file is noise that no reader asked for, and the labels
 * carry the structure on their own.
 */

const RAIL = '│';
const STEP = '◇';
const START = '┌';
const END = '└';
const CORNER_TOP = '╭';
const CORNER_BOTTOM = '╰';
const EDGE = '─';
/** Where a box's rule stops, so a summary does not run the width of a monitor. */
const BOX_WIDTH = 58;

export class Flow {
  constructor(
    private readonly out: CliOutput,
    private readonly style: Style,
  ) {}

  private get on(): boolean {
    return this.style.decorated;
  }

  /** The gutter, styled once so every caller below draws the same one. */
  private gutter(mark: string): string {
    return this.on ? `${this.style.dim(mark)} ` : '';
  }

  private say(mark: string, text: string): void {
    this.out.note(`${this.gutter(mark)}${text}`);
  }

  /** The command's own name on a filled block. The wordmark above it is the program's. */
  open(name: string): void {
    this.say(START, this.style.chip(name));
    this.say(RAIL, '');
  }

  /**
   * One step: what happened, and what it happened to.
   *
   * The value is dimmed and indented under the label because it is the part
   * that is long — a URL, a path, twelve agent names — and the label is the
   * part somebody scans for.
   */
  step(label: string, value?: string): void {
    this.say(STEP, this.style.bold(label));
    if (value !== undefined && value.length > 0) {
      this.say(RAIL, this.style.dim(value));
    }
    this.say(RAIL, '');
  }

  /** A step whose value is the point rather than the label: a code, an id. */
  value(label: string, value: string): void {
    this.say(STEP, this.style.bold(label));
    this.say(RAIL, this.style.accent(value));
    this.say(RAIL, '');
  }

  /**
   * A grouped block, ruled off.
   *
   * For the one part of a run that is a *set* rather than a step — what was
   * written where, which rules arrived — because a dozen of those as steps
   * reads as a dozen things happening rather than one thing with a dozen parts.
   */
  box(title: string, rows: readonly string[]): void {
    if (!this.on) {
      this.say(STEP, title);
      for (const row of rows) this.say(RAIL, row);
      this.say(RAIL, '');
      return;
    }

    const rule = EDGE.repeat(Math.max(BOX_WIDTH - title.length - 2, 0));
    this.say(STEP, `${this.style.bold(title)} ${this.style.dim(`${CORNER_TOP}${rule}`)}`);
    for (const row of rows) this.say(RAIL, `  ${row}`);
    this.say(RAIL, this.style.dim(`${CORNER_BOTTOM}${EDGE.repeat(BOX_WIDTH - 1)}`));
    this.say(RAIL, '');
  }

  /**
   * A line on the rail that is not a step: an aside, a warning, a refusal.
   *
   * For the things that happen *inside* a step and are worth one line. Making
   * each of them a step of its own reads as a dozen things happening rather
   * than one thing with a dozen parts, and printing them off the rail reads as
   * a different command having interrupted this one.
   */
  aside(text: string): void {
    this.say(RAIL, `  ${text}`);
  }

  /**
   * What a question is drawn with, so a prompt sits on the rail like the rest.
   *
   * Readline writes its own line and cannot be handed a renderer, so it is
   * handed the gutter instead. Empty in plain mode, where there is no rail.
   */
  get prompt(): string {
    return this.on ? `${this.style.dim(RAIL)}   ` : '';
  }

  /** The answer, and the end of the rail. */
  close(text: string): void {
    this.say(END, text);
    if (this.on) this.out.note('');
  }

  /** A line under the rail that is not a step: a hint, a next command. */
  hint(text: string): void {
    this.out.note(this.on ? `  ${this.style.dim(text)}` : text);
  }
}
