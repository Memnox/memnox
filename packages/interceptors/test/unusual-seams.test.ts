import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DECISION_EFFECT,
  DEFAULT_NOTICE_SETTINGS,
  FileNoticeStore,
  HOLD_ANSWER,
  HoldService,
  LocalGate,
  NOTICE_MODE,
  UnusualNotice,
  type NoticeMode,
} from '@memnox/core';

import { EgressSeam } from '../src/egress-seam';
import { HookAuthorizer } from '../src/hook-authorizer';
import { ruleOnCommand } from '../src/interceptor';

const NOW = new Date('2026-09-01T09:00:00.000Z');

/** One seam process: its own gate and notice, over the files every seam shares. */
function seamGate(home: string, mode: NoticeMode = NOTICE_MODE.ENFORCE): LocalGate {
  const gate = new LocalGate([], { agentName: 'claude-code' });
  gate.attachNotice(
    new UnusualNotice({
      store: new FileNoticeStore(home),
      agent: 'claude-code',
      sessionId: 'ses_run',
      settings: { ...DEFAULT_NOTICE_SETTINGS, mode, warmupDays: 0 },
      home,
      now: () => NOW,
    }),
  );
  return gate;
}

function counting(): { hold: HoldService; asked: string[] } {
  const asked: string[] = [];
  const hold = new HoldService({
    ask: async (request) => {
      asked.push(request.reason);
      return { answer: HOLD_ANSWER.ONCE };
    },
  });
  return { hold, asked };
}

const home = (): Promise<string> => mkdtemp(join(tmpdir(), 'memnox-unusual-'));

describe('a first-time command through the PATH wrapper', () => {
  it('asks once, and a yes means the next command runs without asking', async () => {
    const dir = await home();
    const { hold, asked } = counting();
    const first = await ruleOnCommand('curl', ['https://api.example.com'], {
      gate: seamGate(dir),
      hold,
    });
    expect(first.allowed).toBe(true);
    expect(asked[0]).toContain(
      'has never done this before: first request to api.example.com',
    );

    // A new process, as the next command is, reading what the last one learned.
    await ruleOnCommand('curl', ['https://api.example.com'], {
      gate: seamGate(dir),
      hold,
    });
    expect(asked).toHaveLength(1);
  });

  it('runs in observe mode and keeps the would-be ask on the row', async () => {
    const outcome = await ruleOnCommand('git', ['push', '--force', 'origin', 'main'], {
      gate: seamGate(await home(), NOTICE_MODE.OBSERVE),
    });
    expect(outcome.allowed).toBe(true);
    expect(outcome.reason).toContain('first force push');
    expect(outcome.reason).toContain('observe mode');
  });
});

describe('a chain that crosses two seams', () => {
  it('asks at the network seam about a credential the shell read', async () => {
    const dir = await home();
    const { hold } = counting();
    const request = { url: 'https://paste.example.net/new', method: 'POST' };
    // Every step familiar first, so only the chain is left to ask.
    const egress = new EgressSeam({
      authorizer: new HookAuthorizer({ gate: seamGate(dir) }),
      hold,
    });
    await egress.gateRequest(request);
    await ruleOnCommand('cat', [join(dir, '.aws', 'credentials')], {
      gate: seamGate(dir),
      hold,
      env: { HOME: dir },
    });

    const gate = seamGate(dir);
    const verdict = gate.evaluate({
      action: 'http.request',
      target: request.url,
      arguments: { method: 'POST', url: request.url },
    });
    expect(verdict.effect).toBe(DECISION_EFFECT.ASK);
    expect(verdict.reason).toContain(
      'read ~/.aws/credentials, then a request to paste.example.net: individually permitted',
    );
  });
});
