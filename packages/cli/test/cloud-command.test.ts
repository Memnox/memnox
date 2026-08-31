import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeAgentConfig } from '../src/agent-config';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import type {
  CloudClient,
  CloudSuggestion,
  CloudTimelineEntry,
} from '../src/cloud-client';
import { ENV_CLOUD_TOKEN, ENV_CLOUD_URL } from '../src/cloud-connection';
import { registerCloudCommand } from '../src/commands/cloud.command';
import { plainStyle } from '../src/style';

const CLOUD = { url: 'https://cloud.acme.test', token: 'mnc_developer' };
const ENV_VARS = [ENV_CLOUD_URL, ENV_CLOUD_TOKEN, 'MEMNOX_CLOUD_WORKSPACE'];

describe('cloud read commands', () => {
  let home: string;
  let out: RecordedOutput;
  let saved: Record<string, string | undefined>;
  let asked: string[];
  let suggestions: CloudSuggestion[];
  let entries: CloudTimelineEntry[];

  const fakeClient = (): CloudClient =>
    ({
      me: async () => ({}),
      suggestions: async (workspace: string) => {
        asked.push(`suggestions:${workspace}`);
        return suggestions;
      },
      timeline: async (workspace: string, limit: number) => {
        asked.push(`timeline:${workspace}:${limit}`);
        return entries;
      },
    }) as unknown as CloudClient;

  const run = async (args: string[]): Promise<void> => {
    const program = new Command();
    program.exitOverride();
    registerCloudCommand(
      program,
      new CliContext(out, undefined, plainStyle),
      home,
      fakeClient,
    );
    await program.parseAsync(args, { from: 'user' });
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'memnox-cloudcmd-'));
    out = new RecordedOutput();
    asked = [];
    suggestions = [];
    entries = [];
    saved = {};
    for (const name of ENV_VARS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(async () => {
    for (const name of ENV_VARS) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    process.exitCode = undefined;
    await rm(home, { recursive: true, force: true });
  });

  const signedIn = (workspace?: string): Promise<string> =>
    writeAgentConfig(home, {
      cloud: { ...CLOUD, ...(workspace === undefined ? {} : { workspace }) },
    });

  it('points someone who has not signed in at the command that fixes it', async () => {
    await run(['suggestions']);

    expect(out.text).toContain('memnox login');
    expect(asked).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it('asks for a workspace rather than guessing one', async () => {
    await signedIn();

    await run(['suggestions']);

    expect(out.text).toContain('--workspace');
    expect(asked).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it('reads the review queue for the stored default workspace', async () => {
    await signedIn('orbit');
    suggestions = [
      {
        id: 's1',
        title: 'Finance owns billing',
        statement: 'Only finance edits it',
        status: 'pending',
      },
    ];

    await run(['suggestions']);

    expect(asked).toEqual(['suggestions:orbit']);
    expect(out.text).toContain('Finance owns billing');
    expect(out.text).toContain('Only finance edits it');
  });

  it('says nothing is waiting rather than printing an empty list', async () => {
    await signedIn('orbit');

    await run(['suggestions']);

    expect(out.text).toContain('Nothing waiting for review');
  });

  it('lets --workspace override the stored default', async () => {
    await signedIn('orbit');

    await run(['suggestions', '--workspace', 'payments']);

    expect(asked).toEqual(['suggestions:payments']);
  });

  it('renders a runtime action on the timeline', async () => {
    await signedIn('orbit');
    entries = [
      {
        kind: 'action',
        id: 'e1',
        occurredAt: '2026-08-07T10:00:00.000Z',
        event: { effect: 'withhold', action: 'shell.execute', target: 'rm -rf /' },
      },
    ];

    await run(['timeline']);

    expect(out.text).toContain('WITHHOLD shell.execute rm -rf /');
  });

  it('renders a source event, which carries no effect', async () => {
    await signedIn('orbit');
    entries = [
      {
        kind: 'source',
        id: 'e2',
        occurredAt: '2026-08-07T09:00:00.000Z',
        event: { sourceType: 'slack_message' },
      },
    ];

    await run(['timeline']);

    // A missing field must read as absent, never crash the listing.
    expect(out.text).toContain('slack_message');
  });

  it('passes the requested limit through', async () => {
    await signedIn('orbit');

    await run(['timeline', '--limit', '5']);

    expect(asked).toEqual(['timeline:orbit:5']);
  });
});
