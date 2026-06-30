import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DECISION_EFFECT, RISK_LEVEL } from '@memnox/core';
import { registerHookCommand } from '../src/commands/hook.command';
import { HOOK_EXIT_BLOCK } from '../src/hook-mapping';
import type { HookHost } from '../src/hook-host';
import { CURSOR_PERMISSION } from '../src/cursor-hook-mapping';
import { FakeRuntime, runCommand } from './cli-harness';

const CHECK_PATH = '/v1/actions/check';

// Assembled at runtime so no credential-shaped literal exists in this file.
const AWS_KEY = ['AKIA', 'IOSFODNN7', 'HOOKTST'].join('');

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

class FakeHost implements HookHost {
  readonly stdout: string[] = [];
  readonly stderr: string[] = [];

  constructor(
    private readonly input: string | null,
    private readonly vars: Record<string, string> = {},
  ) {}

  async readInput(): Promise<string | null> {
    return this.input;
  }

  respond(payload: string): void {
    this.stdout.push(payload);
  }

  warn(message: string): void {
    this.stderr.push(message);
  }

  exit(code: number): never {
    throw new ExitCalled(code);
  }

  env(name: string): string | undefined {
    return this.vars[name];
  }

  cursorResponse(): { permission: string; agent_message?: string } {
    return JSON.parse(this.stdout[0] ?? '{}') as { permission: string };
  }
}

const decision = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  effect: DECISION_EFFECT.ALLOW,
  riskLevel: RISK_LEVEL.LOW,
  reason: 'no policy matched',
  matchedPolicies: [],
  ...over,
});

const WITH_TOKEN = { MEMNOX_AGENT_TOKEN: 'mnx_hook' };

const bashCall = (command: string): string =>
  JSON.stringify({ tool_name: 'Bash', tool_input: { command } });

async function runHook(
  agent: string,
  host: FakeHost,
  runtime: FakeRuntime,
): Promise<void> {
  await runCommand(
    (program, context) => registerHookCommand(program, context, host),
    ['hook', agent],
    runtime,
  );
}

describe('memnox hook claude-code', () => {
  it('stays silent and allows when no agent token is configured', async () => {
    const host = new FakeHost(bashCall('rm -rf /'));
    const runtime = new FakeRuntime();

    await runHook('claude-code', host, runtime);

    expect(host.stderr).toEqual([]);
    expect(runtime.requests).toHaveLength(0);
  });

  it('allows silently when the runtime allows the call', async () => {
    const host = new FakeHost(bashCall('ls'), WITH_TOKEN);
    const runtime = new FakeRuntime().on('POST', CHECK_PATH, decision());

    await runHook('claude-code', host, runtime);

    expect(host.stderr).toEqual([]);
    expect(runtime.requests).toHaveLength(1);
  });

  it('denies with exit 2 and the reason on stderr', async () => {
    const host = new FakeHost(bashCall('psql -c "DROP TABLE users"'), WITH_TOKEN);
    const runtime = new FakeRuntime().on(
      'POST',
      CHECK_PATH,
      decision({ effect: DECISION_EFFECT.BLOCK, reason: 'destructive shell command' }),
    );

    await expect(runHook('claude-code', host, runtime)).rejects.toThrow(
      `exit ${HOOK_EXIT_BLOCK}`,
    );
    expect(host.stderr[0]).toContain('destructive shell command.');
  });

  it('tells the user how to clear a pending approval', async () => {
    const host = new FakeHost(bashCall('deploy'), WITH_TOKEN);
    const runtime = new FakeRuntime().on(
      'POST',
      CHECK_PATH,
      decision({
        effect: DECISION_EFFECT.REQUIRE_APPROVAL,
        reason: 'needs sign-off',
        approvalId: 'apr_3',
      }),
    );

    await expect(runHook('claude-code', host, runtime)).rejects.toThrow(ExitCalled);
    expect(host.stderr[0]).toContain('memnox approvals resolve apr_3');
  });

  it('fails open when the runtime is unreachable', async () => {
    const host = new FakeHost(bashCall('ls'), WITH_TOKEN);
    const runtime = new FakeRuntime(); // every route 404s

    await runHook('claude-code', host, runtime);

    expect(host.stderr).toEqual([]);
  });

  it('fails closed when MEMNOX_HOOK_FAIL_CLOSED is true', async () => {
    const host = new FakeHost(bashCall('ls'), {
      ...WITH_TOKEN,
      MEMNOX_HOOK_FAIL_CLOSED: 'true',
    });
    const runtime = new FakeRuntime();

    await expect(runHook('claude-code', host, runtime)).rejects.toThrow(ExitCalled);
    expect(host.stderr[0]).toContain('failing closed');
  });

  it('ignores unparseable input rather than blocking the editor', async () => {
    const host = new FakeHost('not json', WITH_TOKEN);
    const runtime = new FakeRuntime();

    await runHook('claude-code', host, runtime);

    expect(runtime.requests).toHaveLength(0);
    expect(host.stderr).toEqual([]);
  });

  it('ignores a payload that names no tool', async () => {
    const host = new FakeHost(JSON.stringify({ session_id: 'sess-1' }), WITH_TOKEN);
    const runtime = new FakeRuntime();

    await runHook('claude-code', host, runtime);

    expect(runtime.requests).toHaveLength(0);
  });

  it('governs an unrecognised tool under the tool.* namespace', async () => {
    const host = new FakeHost(JSON.stringify({ tool_name: 'Read' }), WITH_TOKEN);
    const runtime = new FakeRuntime().on('POST', CHECK_PATH, decision());

    await runHook('claude-code', host, runtime);

    expect(runtime.requests[0]?.body).toMatchObject({ action: 'tool.read' });
  });
});

describe('memnox hook claude-code — offline shield', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'memnox-hook-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('blocks a secret write without ever asking the runtime', async () => {
    const file = join(workspace, 'config.ts');
    const host = new FakeHost(
      JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: file, content: `const key = "${AWS_KEY}";` },
      }),
      WITH_TOKEN,
    );
    const runtime = new FakeRuntime();

    await expect(runHook('claude-code', host, runtime)).rejects.toThrow(ExitCalled);
    expect(host.stderr[0]).toContain('aws-access-key');
    expect(host.stderr[0]).not.toContain(AWS_KEY);
    expect(runtime.requests).toHaveLength(0);
  });

  it('does not block an unrelated edit to a file that already has a finding', async () => {
    const file = join(workspace, 'config.ts');
    await writeFile(file, `const key = "${AWS_KEY}";\nconst retries = 1;\n`, 'utf8');

    const host = new FakeHost(
      JSON.stringify({
        tool_name: 'Write',
        tool_input: {
          file_path: file,
          content: `const key = "${AWS_KEY}";\nconst retries = 3;\n`,
        },
      }),
      WITH_TOKEN,
    );
    const runtime = new FakeRuntime().on('POST', CHECK_PATH, decision());

    await runHook('claude-code', host, runtime);

    expect(host.stderr).toEqual([]);
  });
});

describe('memnox hook cursor', () => {
  const cursorCall = (command: string, event = 'beforeShellExecution'): string =>
    JSON.stringify({ hook_event_name: event, command });

  it('answers allow when no token is configured', async () => {
    const host = new FakeHost(cursorCall('ls'));

    await runHook('cursor', host, new FakeRuntime());

    expect(host.cursorResponse().permission).toBe(CURSOR_PERMISSION.ALLOW);
  });

  it('answers allow when the runtime allows', async () => {
    const host = new FakeHost(cursorCall('ls'), WITH_TOKEN);
    const runtime = new FakeRuntime().on('POST', CHECK_PATH, decision());

    await runHook('cursor', host, runtime);

    expect(host.cursorResponse().permission).toBe(CURSOR_PERMISSION.ALLOW);
  });

  it('answers deny with the reason for both the agent and the user', async () => {
    const host = new FakeHost(cursorCall('rm -rf /'), WITH_TOKEN);
    const runtime = new FakeRuntime().on(
      'POST',
      CHECK_PATH,
      decision({ effect: DECISION_EFFECT.BLOCK, reason: 'destructive' }),
    );

    await runHook('cursor', host, runtime);

    const response = host.cursorResponse();
    expect(response.permission).toBe(CURSOR_PERMISSION.DENY);
    expect(response.agent_message).toContain('destructive');
  });

  it('maps require_approval onto ask, not deny', async () => {
    const host = new FakeHost(cursorCall('deploy'), WITH_TOKEN);
    const runtime = new FakeRuntime().on(
      'POST',
      CHECK_PATH,
      decision({ effect: DECISION_EFFECT.REQUIRE_APPROVAL, reason: 'needs sign-off' }),
    );

    await runHook('cursor', host, runtime);

    expect(host.cursorResponse().permission).toBe(CURSOR_PERMISSION.ASK);
  });

  it('only reports on afterFileEdit, since the edit has already landed', async () => {
    const host = new FakeHost(
      JSON.stringify({
        hook_event_name: 'afterFileEdit',
        file_path: '/tmp/x.ts',
        edits: [{ new_string: `const key = "${AWS_KEY}";` }],
      }),
      WITH_TOKEN,
    );
    const runtime = new FakeRuntime();

    await runHook('cursor', host, runtime);

    expect(host.cursorResponse().permission).toBe(CURSOR_PERMISSION.ALLOW);
    expect(host.stderr[0]).toContain('aws-access-key');
  });

  it('answers allow when the payload cannot be parsed', async () => {
    const host = new FakeHost('}{', WITH_TOKEN);

    await runHook('cursor', host, new FakeRuntime());

    expect(host.cursorResponse().permission).toBe(CURSOR_PERMISSION.ALLOW);
  });
});

describe('memnox hook — unsupported agent', () => {
  it('rejects an agent it has no mapping for', async () => {
    const host = new FakeHost(null);

    await expect(runHook('emacs', host, new FakeRuntime())).rejects.toThrow(
      /unsupported hook agent "emacs"/,
    );
  });
});
