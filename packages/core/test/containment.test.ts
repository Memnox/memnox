import { describe, expect, it } from 'vitest';
import {
  CONTAINED,
  CONTAINMENT_SIGNAL,
  containedClassOf,
  containmentAsk,
  hostOfDestination,
  LocalGate,
  type Containment,
  type Policy,
} from '../src/index';

const ROOT = '/work/shop';
const BOUNDARY: Containment = {
  root: ROOT,
  cwd: ROOT,
  home: '/home/dev',
  scratch: ['/tmp', '/private/tmp'],
};

describe('the repository boundary', () => {
  it('asks before a write lands outside the repository', () => {
    const asked = containmentAsk(
      { action: 'filesystem.write', target: '/etc/hosts' },
      BOUNDARY,
    );
    expect(asked?.signal).toBe(CONTAINMENT_SIGNAL.BOUNDARY);
    expect(asked?.reason).toContain('/etc/hosts is outside /work/shop');
  });

  it('asks before a delete outside it, relative paths resolved from where the agent is', () => {
    const asked = containmentAsk(
      { action: 'filesystem.delete', target: '../other/file', workingDirectory: ROOT },
      BOUNDARY,
    );
    expect(asked?.reason).toContain('/work/other/file');
  });

  it('reads a home path as the path it is', () => {
    const asked = containmentAsk(
      { action: 'filesystem.write', target: '~/.zshrc' },
      BOUNDARY,
    );
    expect(asked?.reason).toContain('/home/dev/.zshrc');
  });

  it('lets a write inside the repository, or into temp, through', () => {
    for (const target of ['src/app.ts', `${ROOT}/README.md`, '/tmp/build.log']) {
      expect(containmentAsk({ action: 'filesystem.write', target }, BOUNDARY)).toBeNull();
    }
  });

  it('never asks about a read, wherever it is', () => {
    expect(
      containmentAsk({ action: 'filesystem.read', target: '/etc/hosts' }, BOUNDARY),
    ).toBeNull();
  });

  it('asks about a write inside the repository but outside the paths the task declared', () => {
    const declared = { ...BOUNDARY, paths: ['src/billing/**'] };
    expect(
      containmentAsk(
        { action: 'filesystem.write', target: 'src/billing/invoice.ts' },
        declared,
      ),
    ).toBeNull();
    const asked = containmentAsk(
      { action: 'filesystem.write', target: 'src/auth/login.ts' },
      declared,
    );
    expect(asked?.reason).toContain('outside the paths this task declared');
  });

  it('says nothing where the session has no repository', () => {
    expect(
      containmentAsk({ action: 'filesystem.write', target: '/etc/hosts' }, {}),
    ).toBeNull();
  });
});

describe('what an action counts as', () => {
  it('reads the verb tables, so a push reaches out and a commit stays local', () => {
    expect(containedClassOf('git.push')).toBe(CONTAINED.OUTWARD);
    expect(containedClassOf('git.commit')).toBe(CONTAINED.WRITE);
    expect(containedClassOf('git.push-force')).toBe(CONTAINED.DESTRUCTIVE);
    expect(containedClassOf('git.status')).toBe(CONTAINED.READ);
  });

  it('calls a write through a remote CLI outward, since it changes somebody else', () => {
    expect(containedClassOf('gh.pr-merge')).toBe(CONTAINED.OUTWARD);
  });

  it('takes a tool class the caller already knows', () => {
    expect(containedClassOf('mcp.list_issues', 'read')).toBe(CONTAINED.READ);
    expect(containedClassOf('mcp.send_message', 'communication')).toBe(CONTAINED.OUTWARD);
    expect(containedClassOf('mcp.drop_table', 'destructive')).toBe(CONTAINED.DESTRUCTIVE);
  });

  it('does not call an unknown CLI outward, or every command would ask', () => {
    expect(containedClassOf('shell.execute')).toBe(CONTAINED.READ);
  });
});

describe('an untrusted repository', () => {
  const untrusted: Containment = { ...BOUNDARY, untrusted: true };

  it('asks before anything outward or destructive', () => {
    expect(containmentAsk({ action: 'git.push' }, untrusted)?.signal).toBe(
      CONTAINMENT_SIGNAL.UNTRUSTED,
    );
    expect(
      containmentAsk({ action: 'http.connect', target: 'evil.example:443' }, untrusted)
        ?.signal,
    ).toBe(CONTAINMENT_SIGNAL.UNTRUSTED);
  });

  it('lets package registries and model providers through, which installing needs', () => {
    for (const target of ['registry.npmjs.org:443', 'https://files.pythonhosted.org/x']) {
      expect(containmentAsk({ action: 'http.connect', target }, untrusted)).toBeNull();
    }
    expect(
      containmentAsk(
        { action: 'http.connect', target: 'api.anthropic.com:443' },
        untrusted,
      ),
    ).toBeNull();
  });

  it('does not mistake a lookalike for a registry', () => {
    expect(
      containmentAsk(
        { action: 'http.connect', target: 'registry.npmjs.org.evil.example:443' },
        untrusted,
      ),
    ).not.toBeNull();
  });

  it('lets a write inside the repository through, since that is the work', () => {
    expect(
      containmentAsk({ action: 'filesystem.write', target: 'src/a.ts' }, untrusted),
    ).toBeNull();
  });
});

describe('probation', () => {
  const probation: Containment = {
    probation: {
      name: 'Cursor',
      until: '2026-10-01T00:00:00.000Z',
      trustCommand: 'memnox agents trust cursor',
    },
  };

  it('asks before any write, even inside the repository', () => {
    const asked = containmentAsk(
      { action: 'filesystem.write', target: `${ROOT}/a.ts` },
      { ...probation, root: ROOT },
    );
    expect(asked?.signal).toBe(CONTAINMENT_SIGNAL.PROBATION);
    expect(asked?.reason).toContain('Cursor is on probation until 2026-10-01');
    expect(asked?.reason).toContain('memnox agents trust cursor');
  });

  it('asks before outward and destructive actions, and never before a read', () => {
    expect(containmentAsk({ action: 'git.push' }, probation)).not.toBeNull();
    expect(
      containmentAsk({ action: 'filesystem.delete', target: '/x' }, probation),
    ).not.toBeNull();
    expect(containmentAsk({ action: 'git.log' }, probation)).toBeNull();
  });
});

describe('the local gate under containment', () => {
  const deny: Policy = {
    name: 'no-etc',
    match: { actions: ['filesystem.write'], targets: ['/etc/**'] },
    decision: { effect: 'deny', reason: 'never /etc' },
  } as Policy;

  it('turns an allow into an ask, and says which part of containment asked', () => {
    const gate = new LocalGate([], { agentName: 'claude-code', containment: BOUNDARY });
    const verdict = gate.evaluate({ action: 'filesystem.write', target: '/var/lib/x' });
    expect(verdict.effect).toBe('ask');
    expect(verdict.signals).toContain(CONTAINMENT_SIGNAL.BOUNDARY);
  });

  it('leaves a deny a deny, since containment only ever asks for more', () => {
    const gate = new LocalGate([deny], {
      agentName: 'claude-code',
      containment: BOUNDARY,
    });
    const verdict = gate.evaluate({ action: 'filesystem.write', target: '/etc/hosts' });
    expect(verdict.effect).toBe('deny');
    expect(verdict.reason).toBe('never /etc');
  });

  it('changes nothing without containment', () => {
    const gate = new LocalGate([], { agentName: 'claude-code' });
    expect(
      gate.evaluate({ action: 'filesystem.write', target: '/var/lib/x' }).effect,
    ).toBe('allow');
  });
});

describe('where a request goes', () => {
  it('reads the host from a URL and from a CONNECT authority', () => {
    expect(hostOfDestination('https://API.example.com/v1?key=x')).toBe('api.example.com');
    expect(hostOfDestination('api.example.com:443')).toBe('api.example.com');
  });
});
