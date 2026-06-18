/**
 * Where a command writes. `line` is the payload a caller may pipe; `note` is
 * commentary that must stay out of that pipe. Injected so tests read output
 * instead of capturing the process streams.
 */
export interface CliOutput {
  line(text: string): void;
  note(text: string): void;
}

export class ConsoleOutput implements CliOutput {
  line(text: string): void {
    console.log(text);
  }

  note(text: string): void {
    console.error(text);
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

  get text(): string {
    return this.lines.join('\n');
  }
}
