import { readdir, readFile, rm, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { homedir, userInfo } from 'node:os';
import type { HardenWriter, MachineReader } from './ports';

/** Owner-only: everything written here describes what is reachable on this machine. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** The one place discovery touches the real filesystem, so every detector stays pure. */
export class NodeMachineReader implements MachineReader {
  constructor(
    private readonly home: string = homedir(),
    private readonly user: string = userInfo().username,
  ) {}

  async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      // Absent or unreadable are the same answer to discovery: it cannot see it.
      return false;
    }
  }

  async read(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8');
    } catch {
      // Absent, a directory, or no permission — all of them mean "nothing to read".
      return null;
    }
  }

  async list(path: string): Promise<string[]> {
    try {
      return await readdir(path);
    } catch {
      // Not a directory or not readable; an empty listing is the honest answer.
      return [];
    }
  }

  homeDir(): string {
    return this.home;
  }

  userName(): string {
    return this.user;
  }
}

/** Writes only under the Memnox directory, never into a file the reader's team reviews. */
export class NodeHardenWriter implements HardenWriter {
  constructor(private readonly root: string) {}

  async write(path: string, contents: string): Promise<void> {
    const full = this.resolve(path);
    await mkdir(dirname(full), { recursive: true, mode: DIR_MODE });
    await writeFile(full, contents, { encoding: 'utf8', mode: FILE_MODE });
  }

  async remove(path: string): Promise<void> {
    await rm(this.resolve(path), { force: true });
  }

  async read(path: string): Promise<string | null> {
    try {
      return await readFile(this.resolve(path), 'utf8');
    } catch {
      // Never applied, or already reverted.
      return null;
    }
  }

  /** A step path is always relative to the Memnox root; an absolute one is refused. */
  private resolve(path: string): string {
    if (path.startsWith('/') || path.includes('..')) {
      throw new Error(`a harden step may only write inside ${this.root}: got "${path}"`);
    }
    return `${this.root}/${path}`;
  }
}
