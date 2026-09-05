/** `line` is the payload a caller may pipe; `note` is commentary that stays out of it. */
export interface CliOutput {
  line(text: string): void;
  note(text: string): void;
  /** `--json` on twelve commands, indented the same way on all of them. */
  json(value: unknown): void;
}

const INDENT = 2;

export class ConsoleOutput implements CliOutput {
  line(text: string): void {
    console.log(text);
  }

  note(text: string): void {
    console.error(text);
  }

  json(value: unknown): void {
    this.line(JSON.stringify(value, null, INDENT));
  }
}

export class RecordedOutput implements CliOutput {
  readonly lines: string[] = [];
  readonly notes: string[] = [];

  line(text: string): void {
    this.lines.push(text);
  }

  note(text: string): void {
    this.notes.push(text);
  }

  json(value: unknown): void {
    this.line(JSON.stringify(value, null, INDENT));
  }

  get text(): string {
    return this.lines.join('\n');
  }
}

/** The gutter every detail view aligns on, so `why` and `explain` read as one product. */
const LABEL_WIDTH = 14;

export function row(out: CliOutput, label: string, value: string): void {
  out.line(`  ${label.padEnd(LABEL_WIDTH)}${value}`);
}
