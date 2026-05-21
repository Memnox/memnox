import { appendFile, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  ActionEvent,
  AuditChainVerification,
  AuditLog,
  AuditQuery,
  TextCodec,
} from '@memnox/core';
import {
  AuditChainVerifier,
  chainAuditEvent,
  GENESIS_HASH,
  PLAIN_TEXT_CODEC,
  verifyAuditChain,
} from '@memnox/core';

/** Bytes read per backward step when a bounded query only needs the tail. */
const TAIL_CHUNK_BYTES = 64 * 1_024;
const NEWLINE_BYTE = 0x0a;
const NEWLINE = '\n';
const EMPTY = Buffer.alloc(0);
/** Retention rewrites into a sibling file first — a crash mid-sweep never truncates the log. */
const REWRITE_SUFFIX = '.rewrite';

/** Append-only audit trail as JSON Lines — every decision is provable after the fact. */
export class JsonlAuditLog implements AuditLog {
  constructor(
    private readonly filePath: string,
    private readonly codec: TextCodec = PLAIN_TEXT_CODEC,
  ) {}

  async append(event: ActionEvent): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const linked = chainAuditEvent(event, await this.tipHash());
    await appendFile(this.filePath, `${this.encode(linked)}${NEWLINE}`, 'utf8');
  }

  async recent(limit: number): Promise<ActionEvent[]> {
    return (await this.readTail({}, limit)).reverse();
  }

  async query(filter: AuditQuery): Promise<ActionEvent[]> {
    if (filter.limit !== undefined) return this.readTail(filter, filter.limit);
    const events = await this.readAll();
    return events.filter((event) => matchesAuditQuery(event, filter));
  }

  async pruneBefore(cutoff: string): Promise<number> {
    const events = await this.readAll();
    const retained = events.filter((event) => event.occurredAt >= cutoff);
    const removed = events.length - retained.length;
    if (removed === 0) return 0;
    const rewritePath = `${this.filePath}${REWRITE_SUFFIX}`;
    const body = retained.map((event) => `${this.encode(event)}${NEWLINE}`).join('');
    await writeFile(rewritePath, body, 'utf8');
    await rename(rewritePath, this.filePath);
    return removed;
  }

  async verifyChain(): Promise<AuditChainVerification> {
    return verifyAuditChain(await this.readAll());
  }

  private async tipHash(): Promise<string> {
    const [tip] = await this.readTail({}, 1);
    if (tip === undefined || tip.hash === undefined) return GENESIS_HASH;
    return tip.hash;
  }

  /** Reads backwards in chunks so a bounded query never decodes the whole file. */
  private async readTail(filter: AuditQuery, limit: number): Promise<ActionEvent[]> {
    if (limit <= 0) return [];
    let handle: FileHandle;
    try {
      handle = await open(this.filePath, 'r');
    } catch {
      return []; // The log does not exist until the first append.
    }
    try {
      const collected: ActionEvent[] = [];
      let position = (await handle.stat()).size;
      let carry = EMPTY;
      while (position > 0 && collected.length < limit) {
        const length = Math.min(TAIL_CHUNK_BYTES, position);
        position -= length;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, position);
        const chunk = Buffer.concat([buffer, carry]);
        // Only the chunk that starts at byte 0 is guaranteed to begin on a line boundary.
        const split = position > 0 ? chunk.indexOf(NEWLINE_BYTE) : -1;
        carry =
          position > 0 ? chunk.subarray(0, split < 0 ? chunk.length : split) : EMPTY;
        const body =
          position === 0 ? chunk : split < 0 ? EMPTY : chunk.subarray(split + 1);
        const lines = body.toString('utf8').split(NEWLINE);
        for (
          let index = lines.length - 1;
          index >= 0 && collected.length < limit;
          index -= 1
        ) {
          const line = lines[index];
          if (!line || line.trim().length === 0) continue;
          const event = this.decode(line);
          if (matchesAuditQuery(event, filter)) collected.push(event);
        }
      }
      return collected.reverse();
    } finally {
      await handle.close();
    }
  }

  private async readAll(): Promise<ActionEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      return []; // The log does not exist until the first append.
    }
    return raw
      .split(NEWLINE)
      .filter((line) => line.trim().length > 0)
      .map((line) => this.decode(line));
  }

  private encode(event: ActionEvent): string {
    return this.codec.encode(JSON.stringify(event));
  }

  private decode(line: string): ActionEvent {
    return JSON.parse(this.codec.decode(line)) as ActionEvent;
  }
}

export function matchesAuditQuery(event: ActionEvent, filter: AuditQuery): boolean {
  if (filter.sessionId && event.sessionId !== filter.sessionId) return false;
  if (filter.agentId && event.agentId !== filter.agentId) return false;
  if (filter.orgId && event.orgId !== filter.orgId) return false;
  if (filter.from && event.occurredAt < filter.from) return false;
  if (filter.to && event.occurredAt > filter.to) return false;
  return true;
}
