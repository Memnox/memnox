import { describe, expect, it } from 'vitest';
import {
  AGENT_KIND,
  AGENT_STATUS,
  DECISION_EFFECT,
  EMPTY_AGENT_STATS,
  type AgentIdentity,
} from '@memnox/core';
import { DependencyAdvisor, parsePackageTarget } from '../src/dependency-advisor';
import { DEPENDENCY_SIGNAL } from '../src/dependency.constants';
import { StaticLicenseResolver, type LicenseResolver } from '../src/license-resolver';

const AGENT: AgentIdentity = {
  id: 'agent-1',
  name: 'claude-code',
  kind: AGENT_KIND.CLAUDE_CODE,
  status: AGENT_STATUS.ACTIVE,
  tokenHash: 'hash',
  createdAt: '2026-01-01T00:00:00.000Z',
  stats: { ...EMPTY_AGENT_STATS },
};

const CONTEXT = { agent: AGENT };
const APPROVERS = ['legal'];

const advisorWith = (licenses: Record<string, string> = {}): DependencyAdvisor =>
  new DependencyAdvisor(new StaticLicenseResolver(licenses), APPROVERS);

describe('parsePackageTarget', () => {
  it('splits a plain package from its version', () => {
    expect(parsePackageTarget('left-pad@1.0.0')).toEqual({
      name: 'left-pad',
      version: '1.0.0',
    });
  });

  it('keeps a scoped package name intact', () => {
    expect(parsePackageTarget('@scope/pkg@2.1.0')).toEqual({
      name: '@scope/pkg',
      version: '2.1.0',
    });
    expect(parsePackageTarget('@scope/pkg')).toEqual({
      name: '@scope/pkg',
      version: null,
    });
  });

  it('reports no version when none is pinned', () => {
    expect(parsePackageTarget('express')).toEqual({ name: 'express', version: null });
  });
});

describe('DependencyAdvisor — vulnerabilities', () => {
  it('blocks a known-malicious version outright', async () => {
    const advisories = await advisorWith().advise(
      { action: 'dependency.add', target: 'event-stream@3.3.6' },
      CONTEXT,
    );
    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.escalateTo).toBe(DECISION_EFFECT.BLOCK);
    expect(advisories[0]?.signals).toContain(DEPENDENCY_SIGNAL.KNOWN_VULNERABILITY);
  });

  it('allows a safe version of a package that had a bad one', async () => {
    const advisories = await advisorWith().advise(
      { action: 'dependency.add', target: 'event-stream@4.0.1' },
      CONTEXT,
    );
    expect(advisories).toEqual([]);
  });

  it('flags an unpinned package that has any bad version, since any could install', async () => {
    const advisories = await advisorWith().advise(
      { action: 'dependency.add', target: 'event-stream' },
      CONTEXT,
    );
    expect(advisories).toHaveLength(1);
  });
});

describe('DependencyAdvisor — licenses', () => {
  it('blocks a license the organization does not accept', async () => {
    const advisories = await advisorWith({ 'some-gpl-lib': 'GPL-3.0' }).advise(
      { action: 'dependency.add', target: 'some-gpl-lib' },
      CONTEXT,
    );
    expect(advisories[0]?.escalateTo).toBe(DECISION_EFFECT.BLOCK);
    expect(advisories[0]?.signals).toContain(DEPENDENCY_SIGNAL.BLOCKED_LICENSE);
  });

  it('sends a weak-copyleft license to a human instead of deciding itself', async () => {
    const advisories = await advisorWith({ 'mpl-lib': 'MPL-2.0' }).advise(
      { action: 'dependency.add', target: 'mpl-lib' },
      CONTEXT,
    );
    expect(advisories[0]?.escalateTo).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
    expect(advisories[0]?.approvers).toEqual(APPROVERS);
  });

  it('says nothing about a permissive license', async () => {
    const advisories = await advisorWith({ express: 'MIT' }).advise(
      { action: 'dependency.add', target: 'express' },
      CONTEXT,
    );
    expect(advisories).toEqual([]);
  });

  it('says nothing when the license is unknown', async () => {
    const advisories = await advisorWith().advise(
      { action: 'dependency.add', target: 'mystery-lib' },
      CONTEXT,
    );
    expect(advisories).toEqual([]);
  });

  it('treats a resolver failure as no escalation, never a block', async () => {
    const brokenResolver: LicenseResolver = {
      resolve: async () => {
        throw new Error('registry unreachable');
      },
    };
    const advisories = await new DependencyAdvisor(brokenResolver, APPROVERS).advise(
      { action: 'dependency.add', target: 'express' },
      CONTEXT,
    );
    expect(advisories).toEqual([]);
  });
});

describe('DependencyAdvisor — scope', () => {
  it('ignores actions that are not dependency installs', async () => {
    const advisories = await advisorWith({ 'some-gpl-lib': 'GPL-3.0' }).advise(
      { action: 'code.modify', target: 'some-gpl-lib' },
      CONTEXT,
    );
    expect(advisories).toEqual([]);
  });

  it('ignores a request with no target', async () => {
    const advisories = await advisorWith().advise({ action: 'dependency.add' }, CONTEXT);
    expect(advisories).toEqual([]);
  });
});
