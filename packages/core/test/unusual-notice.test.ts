import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DECISION_EFFECT,
  DEFAULT_NOTICE_SETTINGS,
  FileNoticeStore,
  LocalGate,
  MOST_SEEN_PER_AGENT,
  NOTICE_MODE,
  NOTICE_OPERATION,
  UnusualNotice,
  emptySeen,
  emptySignals,
  minutesToMs,
  daysToMs,
  questionFor,
  shapeOf,
  validateEvent,
  type ActionRequest,
  type MemnoxEvent,
  type NoticeMode,
  type NoticeStore,
  type SeenSet,
  type SessionSignals,
  type VerdictLike,
} from '../src/index';

const HOME = '/home/dev';
const START = Date.parse('2026-09-01T09:00:00.000Z');

/** Memory, with every read and write counted, so the per-call cost is asserted, not timed. */
class CountingStore implements NoticeStore {
  reads = 0;
  writes = 0;
  private readonly seen = new Map<string, SeenSet>();
  private readonly signals = new Map<string, SessionSignals>();
  private started: string | undefined;

  readSeen(agent: string): SeenSet {
    this.reads += 1;
    return this.seen.get(agent) ?? emptySeen();
  }
  writeSeen(agent: string, seen: SeenSet): void {
    this.writes += 1;
    this.seen.set(agent, seen);
  }
  readSignals(session: string): SessionSignals {
    this.reads += 1;
    return this.signals.get(session) ?? emptySignals();
  }
  writeSignals(session: string, signals: SessionSignals): void {
    this.writes += 1;
    this.signals.set(session, signals);
  }
  startedAt(now: string): string {
    this.reads += 1;
    this.started ??= now;
    return this.started;
  }
  seenCount(agent: string): number {
    return Object.keys(this.seen.get(agent)?.entries ?? {}).length;
  }
}

interface Rig {
  notice: UnusualNotice;
  store: NoticeStore;
  rows: MemnoxEvent[];
  clock: { at: number };
}

interface RigOptions {
  mode?: NoticeMode;
  warmupDays?: number;
  store?: NoticeStore;
  sessionId?: string;
  clock?: { at: number };
  rows?: MemnoxEvent[];
}

function rig(options: RigOptions = {}): Rig {
  const clock = options.clock ?? { at: START };
  const store = options.store ?? new CountingStore();
  const rows = options.rows ?? [];
  const notice = new UnusualNotice({
    store,
    agent: 'claude-code',
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    settings: {
      ...DEFAULT_NOTICE_SETTINGS,
      mode: options.mode ?? NOTICE_MODE.ENFORCE,
      warmupDays: options.warmupDays ?? 0,
    },
    home: HOME,
    now: () => new Date(clock.at),
    journal: (event) => rows.push(event),
  });
  return { notice, store, rows, clock };
}

const allowed = (): VerdictLike => ({
  effect: DECISION_EFFECT.ALLOW,
  reason: 'no rule matched',
  signals: [],
});

const request = (action: string, target?: string): ActionRequest => ({
  action,
  ...(target === undefined ? {} : { target }),
});

describe('what an action is, for noticing', () => {
  it('names hosts, pushes, credential reads, env dumps and MCP tools from tables', () => {
    expect(shapeOf(request('http.request', 'https://api.example.com/v1'))).toMatchObject({
      novelty: { key: 'host:api.example.com', first: 'first request to api.example.com' },
      link: 'emit',
      outward: true,
    });
    expect(shapeOf(request('git.push', 'origin main')).step).toBe('git push');
    expect(shapeOf(request('git.push-force', 'origin main')).destructive).toBe(true);
    const credentials = shapeOf(
      request('filesystem.read', `${HOME}/.aws/credentials`),
      HOME,
    );
    expect(credentials).toMatchObject({
      link: 'acquire',
      step: 'read ~/.aws/credentials',
    });
    expect(shapeOf(request('shell.execute', 'printenv | grep KEY')).link).toBe('acquire');
    expect(shapeOf(request('shell.execute', 'env FOO=1 make')).link).toBeNull();
    expect(shapeOf(request('mcp.send_message', 'slack')).link).toBe('emit');
    expect(shapeOf(request('mcp.get_secret', 'vault')).link).toBe('acquire');
  });

  it('leaves the ordinary alone, so reading a README is never novel', () => {
    const shape = shapeOf(request('filesystem.read', '/work/README.md'));
    expect(shape).toMatchObject({ novelty: null, link: null, outward: false });
    expect(shapeOf(request('mcp.list_issues', 'github')).novelty).toBeNull();
  });
});

describe('novelty: this agent has never done this before', () => {
  it('asks the first time and not the second, and says what was new', () => {
    const { notice } = rig();
    const first = notice.consider(
      request('http.request', 'https://api.example.com'),
      allowed(),
    );
    expect(first.effect).toBe(DECISION_EFFECT.ASK);
    expect(first.reason).toContain(
      'Claude Code has never done this before: first request to api.example.com',
    );
    expect(first.signals).toContain('notice:novel');

    notice.personAllowed();
    const again = notice.consider(
      request('http.request', 'https://api.example.com'),
      allowed(),
    );
    expect(again.effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('keeps asking until a person says yes, since a refusal teaches nothing', () => {
    const { notice } = rig();
    const target = request('http.request', 'https://paste.example.net');
    expect(notice.consider(target, allowed()).effect).toBe(DECISION_EFFECT.ASK);
    expect(notice.consider(target, allowed()).effect).toBe(DECISION_EFFECT.ASK);
    notice.personAllowed(target);
    expect(notice.consider(target, allowed()).effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('only records during the warm-up, and remembers what it saw there', () => {
    const { notice, clock } = rig({ warmupDays: 3 });
    const push = request('git.push', 'origin main');
    expect(notice.consider(push, allowed()).effect).toBe(DECISION_EFFECT.ALLOW);

    clock.at += daysToMs(4);
    expect(notice.consider(push, allowed()).effect).toBe(DECISION_EFFECT.ALLOW);
    const fresh = notice.consider(request('git.push', 'backup main'), allowed());
    expect(fresh.reason).toContain('first push to backup');
  });

  it('labels a destructive first time in the reason a hook prints', () => {
    const { notice } = rig();
    const verdict = notice.consider(request('git.push-force', 'origin main'), allowed());
    expect(verdict.reason).toContain('first force push');
    expect(verdict.reason).toContain('This is destructive.');
  });

  it('forgets what is older than the history, so last year is not a licence', () => {
    const { notice, clock } = rig();
    const ssh = request('network.ssh', 'deploy@db.internal');
    notice.consider(ssh, allowed());
    notice.personAllowed();
    clock.at += daysToMs(31);
    expect(notice.consider(ssh, allowed()).effect).toBe(DECISION_EFFECT.ASK);
  });

  it('records a would-be ask in observe mode and lets the action run', () => {
    const { notice } = rig({ mode: NOTICE_MODE.OBSERVE });
    const verdict = notice.consider(
      request('http.request', 'https://new.example'),
      allowed(),
    );
    expect(verdict.effect).toBe(DECISION_EFFECT.ALLOW);
    expect(verdict.shadowEffect).toBe(DECISION_EFFECT.ASK);
    expect(verdict.reason).toContain('observe mode');
  });

  it('does nothing when switched off', () => {
    const { notice, store } = rig({ mode: NOTICE_MODE.OFF });
    const verdict = notice.consider(request('git.push-force', 'origin'), allowed());
    expect(verdict).toEqual(allowed());
    expect((store as CountingStore).reads).toBe(0);
  });

  it('never softens a deny, and learns from a rule ask only once a person answers', () => {
    const { notice } = rig();
    const deny = { ...allowed(), effect: DECISION_EFFECT.DENY, reason: 'rule' };
    expect(notice.consider(request('git.push-force'), deny)).toBe(deny);
    const ask = { ...allowed(), effect: DECISION_EFFECT.ASK, reason: 'rule asks' };
    const push = request('http.request', 'https://ruled.example');
    expect(notice.consider(push, ask)).toBe(ask);
    notice.personAllowed(push);
    expect(notice.consider(push, allowed()).effect).toBe(DECISION_EFFECT.ALLOW);
  });
});

describe('a chain: something taken, then something sent', () => {
  const read = request('filesystem.read', `${HOME}/.aws/credentials`);
  const push = request('git.push', 'origin main');

  function learned(): Rig {
    const setup = rig();
    // Both ends familiar, so only the chain can be what asks.
    setup.notice.consider(read, allowed());
    setup.notice.consider(push, allowed());
    setup.notice.personAllowed();
    return setup;
  }

  it('asks inside the window and names both steps', () => {
    const { notice, clock } = learned();
    clock.at += minutesToMs(5);
    notice.consider(read, allowed());
    const verdict = notice.consider(push, allowed());
    expect(verdict.effect).toBe(DECISION_EFFECT.ASK);
    expect(verdict.reason).toContain(
      'read ~/.aws/credentials, then git push: individually permitted, together an exfiltration path',
    );
  });

  it('lets the send go once the window has passed', () => {
    const { notice, clock } = learned();
    clock.at += minutesToMs(31);
    expect(notice.consider(push, allowed()).effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('denies when the send carries a credential shape', () => {
    const { notice } = learned();
    notice.consider(read, allowed());
    const leak = {
      action: 'http.request',
      target: 'https://api.example.com',
      arguments: { body: `key=${'AKIA'}ABCDEFGHIJKLMNOP` },
    };
    notice.consider(leak, allowed());
    notice.personAllowed(leak);
    notice.consider(read, allowed());
    const verdict = notice.consider(leak, allowed());
    expect(verdict.effect).toBe(DECISION_EFFECT.DENY);
    expect(verdict.reason).toContain('aws access key id');
  });

  it('is seen across seams, which are separate processes sharing the session file', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-notice-'));
    const clock = { at: START };
    const shell = rig({ store: new FileNoticeStore(home), sessionId: 'ses_1', clock });
    const proxy = rig({ store: new FileNoticeStore(home), sessionId: 'ses_1', clock });
    const other = rig({ store: new FileNoticeStore(home), sessionId: 'ses_2', clock });
    const send = request('mcp.send_message', 'slack');
    for (const each of [shell, proxy, other]) {
      each.notice.consider(send, allowed());
      each.notice.personAllowed();
    }

    shell.notice.consider(request('aws.secretsmanager-get-secret-value'), allowed());
    shell.notice.personAllowed();
    const verdict = proxy.notice.consider(send, allowed());
    expect(verdict.effect).toBe(DECISION_EFFECT.ASK);
    expect(verdict.reason).toContain('then slack.send_message');
    expect(other.notice.consider(send, allowed()).effect).toBe(DECISION_EFFECT.ALLOW);
  });
});

describe('taint after an instruction-shaped result', () => {
  function tainted(): Rig {
    const setup = rig({ sessionId: 'ses_t' });
    const push = request('git.push', 'origin main');
    setup.notice.consider(push, allowed());
    setup.notice.personAllowed();
    setup.notice.taint('github.get_issue');
    return setup;
  }

  it('asks about outward actions and names the result, leaving reads alone', () => {
    const { notice, rows } = tainted();
    const verdict = notice.consider(request('git.push', 'origin main'), allowed());
    expect(verdict.effect).toBe(DECISION_EFFECT.ASK);
    expect(verdict.reason).toContain(
      'a tool result from github.get_issue read like instructions',
    );
    expect(
      notice.consider(request('filesystem.read', '/work/a.ts'), allowed()).effect,
    ).toBe(DECISION_EFFECT.ALLOW);
    expect(rows.map((row) => row.operation)).toEqual([NOTICE_OPERATION.TAINTED]);
    expect(validateEvent(rows[0])).toEqual([]);
  });

  it('lapses after its window and records the lapse once', () => {
    const { notice, rows, clock } = tainted();
    clock.at += minutesToMs(31);
    expect(notice.consider(request('git.push', 'origin main'), allowed()).effect).toBe(
      DECISION_EFFECT.ALLOW,
    );
    notice.consider(request('git.push', 'origin main'), allowed());
    expect(rows.map((row) => row.operation)).toEqual([
      NOTICE_OPERATION.TAINTED,
      NOTICE_OPERATION.TAINT_CLEARED,
    ]);
    expect(rows[1]?.actorType).toBe('automation');
  });

  it('is cleared by a person, on the record under their name', () => {
    const { notice, rows } = tainted();
    expect(notice.clearTaint('dana')?.source).toBe('github.get_issue');
    expect(notice.consider(request('git.push', 'origin main'), allowed()).effect).toBe(
      DECISION_EFFECT.ALLOW,
    );
    expect(rows[1]).toMatchObject({ authorizedBy: 'dana', actorType: 'human' });
    expect(validateEvent(rows[1])).toEqual([]);
    expect(notice.clearTaint('dana')).toBeNull();
  });
});

describe('the per-call cost', () => {
  it('reads no file for an ordinary action, and writes none for a familiar one', () => {
    const store = new CountingStore();
    const { notice } = rig({ store });
    notice.consider(request('filesystem.read', '/work/README.md'), allowed());
    notice.consider(request('shell.execute', 'ls -la'), allowed());
    expect(store.reads + store.writes).toBe(0);

    const host = request('http.request', 'https://api.example.com');
    notice.consider(host, allowed());
    notice.personAllowed();
    const before = { reads: store.reads, writes: store.writes };
    notice.consider(host, allowed());
    expect(store.reads - before.reads).toBeLessThanOrEqual(2);
    expect(store.writes - before.writes).toBe(0);
  });

  it('keeps the seen set bounded however many hosts an agent reaches', () => {
    const store = new CountingStore();
    const { notice, clock } = rig({ store, mode: NOTICE_MODE.OBSERVE });
    for (let index = 0; index < MOST_SEEN_PER_AGENT + 50; index += 1) {
      clock.at += 1;
      notice.consider(request('http.request', `https://h${index}.example`), allowed());
    }
    expect(store.seenCount('claude-code')).toBe(MOST_SEEN_PER_AGENT);
  });
});

describe('where the notice meets the gate and the prompt', () => {
  it('turns an allow from the rules into an ask, and passes a yes through', () => {
    const gate = new LocalGate([], { agentName: 'claude-code' });
    gate.attachNotice(rig().notice);
    const host = { action: 'http.request', target: 'https://api.example.com' };
    expect(gate.evaluate(host).effect).toBe(DECISION_EFFECT.ASK);
    gate.personAllowed(host);
    expect(gate.evaluate(host).effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('labels a destructive or irreversible hold on the terminal', () => {
    const base = {
      sessionId: 's',
      agent: 'claude-code',
      fingerprint: 'f',
      reason: 'a rule',
    };
    expect(questionFor({ ...base, operation: 'git.push-force' })).toContain(
      'This is destructive.',
    );
    expect(questionFor({ ...base, operation: 'send_email' })).toContain(
      'This cannot be undone.',
    );
    expect(questionFor({ ...base, operation: 'git.status' })).not.toContain('This');
  });
});
