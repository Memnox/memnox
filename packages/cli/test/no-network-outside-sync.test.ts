import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The promise on the front page, as a test.
 *
 * *No account. No network. Nothing leaves your machine* is the open half's whole
 * credibility, and `memnox login` is the one thing that changes it. Keeping every
 * outbound call in one module is what makes the claim checkable rather than
 * believed: a reviewer reads `src/sync/client.ts` and is done.
 *
 * If this fails, the fix is to route the call through `callCloud` — not to widen
 * the list below.
 */

const ROOT = join(__dirname, '..', 'src');

/**
 * Every file allowed to name a socket, and why. Two entries, both deliberate.
 *
 * `node:net` is in the pattern rather than excluded from it, because the same
 * import opens a unix socket and a TCP one — so the daemon is named here and
 * pinned to the unix side by the test below.
 */
const ALLOWED: Record<string, string> = {
  'sync/client.ts': 'the one outbound module; nothing runs until `memnox login`',
  'daemon-server.ts': 'a unix socket on this machine, pinned by the next test',
};

/** Anything that opens a socket or resolves a name. */
const OUTBOUND =
  /\bfetch\s*\(|node:https?['"]|node:dgram|node:net|new WebSocket|XMLHttpRequest/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('nothing reaches the network but the sync client', () => {
  it('keeps every outbound call in one module', () => {
    const offenders = sources(ROOT)
      .filter((path) => OUTBOUND.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(ROOT.length + 1))
      .filter((path) => ALLOWED[path] === undefined);

    expect(
      offenders,
      'route it through callCloud in src/sync/client.ts rather than widening this list',
    ).toEqual([]);
  });

  /* The daemon listens on a unix socket, which is not a network — but a change
     from `node:net` to a TCP port would be, and would pass unnoticed without
     this. Named rather than excluded, so the exception is a decision. */
  it('leaves the daemon on a unix socket', () => {
    const daemon = readFileSync(join(ROOT, 'daemon-server.ts'), 'utf8');

    expect(daemon).toContain('createServer');
    expect(daemon).not.toMatch(/listen\(\s*\d/);
  });
});
