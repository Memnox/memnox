import type { HardenWriter, MachineReader } from '../src/ports';

/** An in-memory machine: every detector is a pure function of what this says exists. */
export class FakeMachine implements MachineReader, HardenWriter {
  constructor(
    private readonly files: Map<string, string>,
    private readonly home = '/home/dev',
    private readonly user = 'dev',
  ) {}

  static from(files: Record<string, string>, home = '/home/dev'): FakeMachine {
    return new FakeMachine(new Map(Object.entries(files)), home);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async list(path: string): Promise<string[]> {
    const prefix = `${path}/`;
    return [...this.files.keys()]
      .filter((each) => each.startsWith(prefix))
      .map((each) => each.slice(prefix.length));
  }

  homeDir(): string {
    return this.home;
  }

  userName(): string {
    return this.user;
  }

  async write(path: string, contents: string): Promise<void> {
    this.files.set(path, contents);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  get written(): string[] {
    return [...this.files.keys()];
  }
}
