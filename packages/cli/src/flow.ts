import type { CliOutput } from './cli-output';
import type { Style } from './style';

/**
 * A command that reports its steps as it takes them.
 *
 * One vertical rail down the left, a marker at each step, and the value under
 * its label rather than beside it — so a long path or a list of names wraps
 * into the gutter instead of pushing the next column off the screen. `setup`
 * is the shape this is for: several things happen in order, each one is worth
 * seeing, and the last one is the answer.
 *
 * **Every command draws on one of these, and only one.** A product where
 * `setup` reports on a rail and `doctor` prints a bare list is one that reads
 * as two tools sharing a binary, so the shapes a report needs are methods
 * here rather than padding hand-rolled in thirty files: a card of labelled
 * facts, a table, a list of things that are wrong. Two commands that align
 * their columns separately are two commands that align them differently.
 *
 * **Where it writes is the command's own decision, and the default is stdout.**
 * A rail that *is* the answer belongs where an answer goes, or `memnox doctor
 * > report.txt` writes an empty file. `commentary()` moves it to stderr, for
 * the handful of runs that print something a caller pipes: `login` answers
 * with a machine id, `env` with shell exports, `timeline --export` with the
 * export. `--json` bypasses it entirely, by never opening it.
 *
 * **The header is drawn on first use rather than on `open`.** A command that
 * opens a rail and then answers `--json`, or prints one bare value and
 * nothing else, must not leave a chip and a stub of gutter above it, and
 * `open` happens before the command knows which of those it is. A rail nobody
 * opened draws nothing at all, which is what makes the `--json` path a matter
 * of not opening one rather than a flag threaded through every call below.
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
/** The gutter a card's values align on, so two commands' cards read as one. */
const LABEL_WIDTH = 12;
/** Between one column and the next, so nothing ever touches. */
const GAP = '  ';

/**
 * What a row in a list is: worth doing, worth looking at, or neither.
 *
 * A marker rather than a colour alone, because a reader scanning for the
 * things that are wrong is scanning the left edge and colour does not survive
 * a paste into an issue.
 */
export const TONE = {
  /** Working as intended, or a thing that was added. */
  OK: 'ok',
  /** Worth somebody's attention. Never a verdict. */
  WARN: 'warn',
  /** True and not interesting: context for the rows above it. */
  DIM: 'dim',
  /** A row with nothing to say about itself. */
  PLAIN: 'plain',
} as const;

export type Tone = (typeof TONE)[keyof typeof TONE];

const MARK: Record<Tone, string> = {
  [TONE.OK]: '+',
  [TONE.WARN]: '!',
  [TONE.DIM]: '·',
  [TONE.PLAIN]: ' ',
};

/** One labelled fact in a card. */
export interface FlowRow {
  label: string;
  value: string;
}

/** One row in a list: what it is, and the lines under it that say why. */
export interface FlowItem {
  tone?: Tone;
  text: string;
  detail?: readonly (string | undefined)[];
}

/** What is actually on screen: colour is a cost the column widths must not pay. */
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

const seen = (text: string): number => text.replace(ANSI_PATTERN, '').length;

/** Padded to a visible width, so a styled cell lands in the same column as a plain one. */
const pad = (text: string, width: number): string =>
  `${text}${' '.repeat(Math.max(width - seen(text), 0))}`;

export class Flow {
  /** The name, once `open` has been called. Undefined means nothing draws. */
  private name: string | undefined;
  /** Whether the header has been flushed, so it is drawn once and not per line. */
  private opened = false;
  private closed = false;
  private toStderr = false;

  constructor(
    private readonly out: CliOutput,
    private readonly style: Style,
  ) {}

  private get on(): boolean {
    return this.style.decorated;
  }

  /** The command's own name on a filled block. The wordmark above it is the program's. */
  open(name: string): void {
    this.name = name;
    this.opened = false;
    this.closed = false;
  }

  /**
   * Move this rail to stderr, for a run whose answer is something else.
   *
   * Called before anything is drawn, which the lazy header makes possible: a
   * command decides it has a payload at the top of its action, and the chip
   * has not been written to the wrong stream by then.
   */
  commentary(): void {
    this.toStderr = true;
  }

  /** The one place either stream is written, so a rail never lands on both. */
  private write(text: string): void {
    if (this.toStderr) this.out.note(text);
    else this.out.line(text);
  }

  /** The gutter, styled once so every caller below draws the same one. */
  private gutter(mark: string): string {
    return this.on ? `${this.style.dim(mark)} ` : '';
  }

  private say(mark: string, text: string): void {
    const name = this.name;
    if (name === undefined) return;
    if (!this.opened) {
      this.opened = true;
      this.write(`${this.gutter(START)}${this.style.chip(name)}`);
      this.write(`${this.gutter(RAIL)}`);
    }
    this.write(`${this.gutter(mark)}${text}`);
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
   * A card of labelled facts: an id, a path, a time, a verdict.
   *
   * The padding is owned here rather than by the caller, because it is the
   * thing every detail view in this CLI was doing separately and therefore
   * differently: an enrolment card, a traced action and an agent's status all
   * printed label-then-value and none of them lined up with the others. A
   * label wider than the gutter widens the card rather than pushing its own
   * value out of the column.
   */
  rows(title: string, rows: readonly (FlowRow | undefined)[]): void {
    const shown = rows.filter((row): row is FlowRow => row !== undefined);
    /* Two spaces clear of the longest label, never one: a label that lands
       exactly on the gutter would otherwise sit flush against its own value. */
    const width = Math.max(LABEL_WIDTH, ...shown.map((row) => row.label.length + 2));
    this.box(
      title,
      shown.map((row) => `${this.style.dim(row.label.padEnd(width))}${row.value}`),
    );
  }

  /**
   * A table, headed and aligned.
   *
   * Columns are measured and padded on what a reader can **see**, not on what
   * the string holds: an escape sequence has a width nobody can see and
   * `padEnd` can, so a coloured cell padded by length leaves every column after
   * it ragged. Doing it here rather than asking each caller to colour last is
   * what lets a verdict, a status or a severity be styled in the cell it
   * belongs in, which is the version of that rule every caller got wrong.
   */
  table(
    title: string,
    headers: readonly string[],
    rows: readonly (readonly string[])[],
  ): void {
    const widths = headers.map((header, column) =>
      Math.max(seen(header), ...rows.map((row) => seen(row[column] ?? ''))),
    );
    /* The last column is never padded: trailing spaces on every row are
       invisible until somebody copies the block into a diff. */
    const lay = (cells: readonly string[]): string =>
      cells
        .map((cell, column) =>
          column === cells.length - 1 ? cell : pad(cell, widths[column] ?? 0),
        )
        .join(GAP)
        .trimEnd();

    this.box(title, [this.style.dim(lay(headers)), ...rows.map(lay)]);
  }

  /**
   * A list of things, each with the lines under it that say why.
   *
   * The marker carries the meaning and the colour only reinforces it, because
   * this is the shape a reader scans down the left edge of, whether that is
   * what the doctor found, what a scan says arrived, or what two agents
   * collided over, and half of them end up pasted somewhere with no colour.
   */
  list(title: string, items: readonly FlowItem[]): void {
    const lines: string[] = [];
    for (const item of items) {
      const tone = item.tone ?? TONE.PLAIN;
      lines.push(`${this.tone(tone, MARK[tone])}  ${item.text}`);
      for (const detail of item.detail ?? []) {
        if (detail === undefined || detail === '') continue;
        lines.push(`   ${this.style.dim(detail)}`);
      }
    }
    this.box(title, lines);
  }

  /** One tone, resolved to the style that draws it. */
  private tone(tone: Tone, text: string): string {
    if (tone === TONE.OK) return this.style.ok(text);
    if (tone === TONE.WARN) return this.style.warn(text);
    if (tone === TONE.DIM) return this.style.dim(text);
    return text;
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

  /** Whether a command opened a rail at all, so a caller can fall back to a bare line. */
  get drawing(): boolean {
    return this.name !== undefined;
  }

  /**
   * The end of a run that refused, said on stderr wherever the rail is drawn.
   *
   * Attached to the rail, because a reason printed loose under an open gutter
   * reads as a crash rather than as the answer, and a refusal somebody can act
   * on is the one kind of ending that most needs to read as an answer. On
   * stderr whatever channel the rail took, because that is the half a script
   * reads and a redirected run must still show its reason on the terminal.
   */
  fail(text: string): void {
    const name = this.name;
    if (name === undefined) return;
    if (this.opened) {
      this.say(RAIL, '');
    } else {
      /* Nothing was drawn before the refusal, so the header goes on stderr with
         it. A chip on stdout above a reason on stderr leaves a stub in whatever
         the run was redirected into and the reason nowhere near it. */
      this.opened = true;
      this.out.note(`${this.gutter(START)}${this.style.chip(name)}`);
      this.out.note(`${this.gutter(RAIL)}`);
    }
    this.out.note(`${this.gutter(END)}${text}`);
    this.closed = true;
    if (this.on) this.out.note('');
  }

  /** The answer, and the end of the rail. */
  close(text: string): void {
    this.say(END, text);
    this.closed = true;
    if (this.on && this.name !== undefined) this.write('');
  }

  /**
   * The rail, terminated, whatever the command did.
   *
   * Called from one place after every action, so a command that returned early
   * with no findings, nothing logged in, or a refusal it named, cannot leave an
   * open gutter hanging under the last thing it said. It draws nothing where nothing was
   * drawn, and nothing where `close` already said the answer.
   */
  end(): void {
    if (!this.opened || this.closed) return;
    this.close('');
  }

  /** A line under the rail that is not a step: a hint, a next command. */
  hint(text: string): void {
    if (this.name === undefined) return;
    this.write(this.on ? `  ${this.style.dim(text)}` : text);
  }
}
