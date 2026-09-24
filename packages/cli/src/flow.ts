import type { CliOutput } from './cli-output';
import type { Style } from './style';

/**
 * The rail every command reports on: a marker per step and the value under its label, so
 * a long path wraps into the gutter. The header draws on first use, so `--json` leaves nothing.
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

/** What a row in a list is, as a marker rather than a colour, since colour does not survive a paste. */
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

function visibleWidth(text: string): number {
  return text.replace(ANSI_PATTERN, '').length;
}

/** Padded to a visible width, so a styled cell lands in the same column as a plain one. */
function pad(text: string, width: number): string {
  return `${text}${' '.repeat(Math.max(width - visibleWidth(text), 0))}`;
}

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

  private get decorated(): boolean {
    return this.style.decorated;
  }

  /** The command's own name on a filled block. The wordmark above it is the program's. */
  open(name: string): void {
    this.name = name;
    this.opened = false;
    this.closed = false;
  }

  /** Move this rail to stderr, for a run whose answer is something else. Call before anything is drawn. */
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
    return this.decorated ? `${this.style.dim(mark)} ` : '';
  }

  private draw(mark: string, text: string): void {
    const name = this.name;
    if (name === undefined) return;
    if (!this.opened) {
      this.opened = true;
      this.write(`${this.gutter(START)}${this.style.chip(name)}`);
      this.write(`${this.gutter(RAIL)}`);
    }
    this.write(`${this.gutter(mark)}${text}`);
  }

  /** One step: the label is what somebody scans for, and the value under it is the long part. */
  step(label: string, value?: string): void {
    this.draw(STEP, this.style.bold(label));
    if (value !== undefined && value.length > 0) {
      this.draw(RAIL, this.style.dim(value));
    }
    this.draw(RAIL, '');
  }

  /** A step whose value is the point rather than the label: a code, an id. */
  value(label: string, value: string): void {
    this.draw(STEP, this.style.bold(label));
    this.draw(RAIL, this.style.accent(value));
    this.draw(RAIL, '');
  }

  /** A grouped block, for a set rather than a step, so a dozen parts read as one thing. */
  box(title: string, rows: readonly string[]): void {
    if (!this.decorated) {
      this.draw(STEP, title);
      for (const row of rows) this.draw(RAIL, row);
      this.draw(RAIL, '');
      return;
    }

    const rule = EDGE.repeat(Math.max(BOX_WIDTH - title.length - 2, 0));
    this.draw(
      STEP,
      `${this.style.bold(title)} ${this.style.dim(`${CORNER_TOP}${rule}`)}`,
    );
    for (const row of rows) this.draw(RAIL, `  ${row}`);
    this.draw(RAIL, this.style.dim(`${CORNER_BOTTOM}${EDGE.repeat(BOX_WIDTH - 1)}`));
    this.draw(RAIL, '');
  }

  /**
   * A card of labelled facts, padded here rather than by each caller so every detail view
   * lines up the same way. A label wider than the gutter widens the card.
   */
  rows(title: string, rows: readonly (FlowRow | undefined)[]): void {
    const shown = rows.filter((row): row is FlowRow => row !== undefined);
    // Two spaces clear of the longest label, or one landing on the gutter touches its value.
    const width = Math.max(LABEL_WIDTH, ...shown.map((row) => row.label.length + 2));
    this.box(
      title,
      shown.map((row) => `${this.style.dim(row.label.padEnd(width))}${row.value}`),
    );
  }

  /**
   * A table, aligned on visible width rather than string length, because an escape
   * sequence has a width `padEnd` counts and a reader cannot see.
   */
  table(
    title: string,
    headers: readonly string[],
    rows: readonly (readonly string[])[],
  ): void {
    const widths = headers.map((header, column) =>
      Math.max(
        visibleWidth(header),
        ...rows.map((row) => visibleWidth(row[column] ?? '')),
      ),
    );
    // The last column is never padded, since trailing spaces surface in a pasted diff.
    const lay = (cells: readonly string[]): string =>
      cells
        .map((cell, column) =>
          column === cells.length - 1 ? cell : pad(cell, widths[column] ?? 0),
        )
        .join(GAP)
        .trimEnd();

    this.box(title, [this.style.dim(lay(headers)), ...rows.map(lay)]);
  }

  /** A list of things with the lines under each saying why. The marker carries the meaning, not the colour. */
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

  /** A line on the rail that is not a step, for what happens inside one and is worth a line. */
  aside(text: string): void {
    this.draw(RAIL, `  ${text}`);
  }

  /**
   * What a question is drawn with, so a prompt sits on the rail: readline writes its own
   * line and takes a gutter rather than a renderer. Empty in plain mode.
   */
  get prompt(): string {
    return this.decorated ? `${this.style.dim(RAIL)}   ` : '';
  }

  /** Whether a command opened a rail at all, so a caller can fall back to a bare line. */
  get drawing(): boolean {
    return this.name !== undefined;
  }

  /**
   * The end of a run that refused, attached to the rail so it reads as the answer. Always
   * on stderr, so a redirected run still shows its reason on the terminal.
   */
  fail(text: string): void {
    const name = this.name;
    if (name === undefined) return;
    if (this.opened) {
      this.draw(RAIL, '');
    } else {
      // Nothing was drawn yet, so the header goes to stderr with the reason rather than
      // leaving a stub in whatever stdout was redirected into.
      this.opened = true;
      this.out.note(`${this.gutter(START)}${this.style.chip(name)}`);
      this.out.note(`${this.gutter(RAIL)}`);
    }
    this.out.note(`${this.gutter(END)}${text}`);
    this.closed = true;
    if (this.decorated) this.out.note('');
  }

  /** The answer, and the end of the rail. */
  close(text: string): void {
    this.draw(END, text);
    this.closed = true;
    if (this.decorated && this.name !== undefined) this.write('');
  }

  /**
   * The rail, terminated, whatever the command did. Called after every action, so an early
   * return cannot leave an open gutter.
   */
  end(): void {
    if (!this.opened || this.closed) return;
    this.close('');
  }

  /** A line under the rail that is not a step: a hint, a next command. */
  hint(text: string): void {
    if (this.name === undefined) return;
    this.write(this.decorated ? `  ${this.style.dim(text)}` : text);
  }
}
