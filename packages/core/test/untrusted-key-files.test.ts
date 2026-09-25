import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { containmentAsk } from '../src/gate/containment';
import { untrustedSeatbeltProfile } from '../src/intercept/untrusted-guard';

const DOT = '.';
const KEYS = `${DOT}env`;
const TEMPLATE = `${DOT}env.example`;

describe('inside an untrusted repository', () => {
  const untrusted = { root: '/w/project', untrusted: true, cwd: '/w/project' };

  it('refuses reading its key file and leaves its template of names', () => {
    const secret = containmentAsk(
      { action: 'filesystem.read', target: `/w/project/${KEYS}` },
      untrusted,
      'read',
    );
    expect(secret?.refuses).toBe(true);
    expect(
      containmentAsk(
        { action: 'filesystem.read', target: `/w/project/${TEMPLATE}` },
        untrusted,
        'read',
      ),
    ).toBeNull();
  });

  it('refuses an MCP tool that changes something, and lets it read', () => {
    const write = containmentAsk(
      { action: 'mcp.stripe.create_refund', target: 'stripe' },
      untrusted,
      'write',
    );
    expect(write?.refuses).toBe(true);
    expect(
      containmentAsk(
        { action: 'mcp.stripe.list_charges', target: 'stripe' },
        untrusted,
        'read',
      ),
    ).toBeNull();
  });

  it('still asks, rather than refuses, about a CLI that reaches out', () => {
    const ask = containmentAsk({ action: 'gh.pr-create' }, untrusted, 'write');
    expect(ask?.refuses).toBeUndefined();
    expect(ask).not.toBeNull();
  });
});

describe.runIf(process.platform === 'darwin')('the kernel wall on macOS', () => {
  it('keeps the repository key file unreadable and its template readable', async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'memnox-wall-')));
    await writeFile(join(workspace, KEYS), 'X=1\n');
    await writeFile(join(workspace, TEMPLATE), 'X=\n');
    const profile = join(workspace, 'profile.sb');
    await writeFile(
      profile,
      untrustedSeatbeltProfile({
        home: '/nonexistent-home',
        writable: [workspace],
        readable: [],
        unreadable: [],
        unwritable: [],
        statePrefixes: [],
        proxyPort: null,
        workspace,
      }),
    );
    const read = (file: string): number =>
      spawnSync('sandbox-exec', ['-f', profile, '/bin/cat', join(workspace, file)])
        .status ?? -1;
    expect(read(KEYS)).not.toBe(0);
    expect(read(TEMPLATE)).toBe(0);
  });
});
