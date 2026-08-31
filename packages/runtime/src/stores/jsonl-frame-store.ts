import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Frame, FrameStore } from '@memnox/ledger';
import { SECRET_DIR_MODE, SECRET_FILE_MODE } from './file-mode';

/**
 * A local database file, not a log directory. Append-only, one frame per line, so a
 * session is reconstructed from rows rather than grepped out of prose.
 */
export class JsonlFrameStore implements FrameStore {
  constructor(private readonly filePath: string) {}

  async append(frame: Frame): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: SECRET_DIR_MODE });
    await appendFile(this.filePath, `${JSON.stringify(frame)}\n`, {
      encoding: 'utf8',
      mode: SECRET_FILE_MODE,
    });
  }

  async bySession(sessionId: string): Promise<Frame[]> {
    return (await this.all()).filter((frame) => frame.sessionId === sessionId);
  }

  /** Retention is a setting with a default, because a laptop is not a warehouse. */
  async prune(before: string): Promise<number> {
    const frames = await this.all();
    const kept = frames.filter((frame) => frame.at >= before);
    if (kept.length === frames.length) return 0;
    await writeFile(
      this.filePath,
      kept.map((frame) => JSON.stringify(frame)).join('\n') +
        (kept.length > 0 ? '\n' : ''),
      { encoding: 'utf8', mode: SECRET_FILE_MODE },
    );
    return frames.length - kept.length;
  }

  async all(): Promise<Frame[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      // First run — nothing has been recorded on this machine yet.
      return [];
    }
    const frames: Frame[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        frames.push(JSON.parse(line) as Frame);
      } catch {
        // A torn final line from a crash mid-append; the rest of the file is intact.
        continue;
      }
    }
    return frames;
  }
}

/** Zero-infrastructure default, and what the tests drive. */
export class InMemoryFrameStore implements FrameStore {
  private frames: Frame[] = [];

  async append(frame: Frame): Promise<void> {
    this.frames.push(frame);
  }

  async bySession(sessionId: string): Promise<Frame[]> {
    return this.frames.filter((frame) => frame.sessionId === sessionId);
  }

  async prune(before: string): Promise<number> {
    const kept = this.frames.filter((frame) => frame.at >= before);
    const dropped = this.frames.length - kept.length;
    this.frames = kept;
    return dropped;
  }

  async all(): Promise<Frame[]> {
    return [...this.frames];
  }
}
