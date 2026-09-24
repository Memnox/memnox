import { describe, expect, it } from 'vitest';
import {
  DECISION_EFFECT,
  ENFORCEMENT_MODE,
  EVENT_SCHEMA_VERSION,
  EVENT_SURFACE,
  TOOL_EFFECT,
  type EnvironmentSnapshot,
  type MemnoxEvent,
} from '@memnox/core';

import { draftFrom } from '../src/sync/action-rows';
import { documentFrom, type Bundle } from '../src/sync/bundle';
import { censusFrom } from '../src/sync/census';

const TAKEN_AT = '2026-09-01T09:00:00.000Z';

const snapshot: EnvironmentSnapshot = {
  takenAt: TAKEN_AT,
  agents: [],
  resources: [],
  servers: [
    {
      name: 'stripe',
      grantedBy: '/home/dev/.cursor/mcp.json',
      agentIds: ['cursor'],
      tools: [
        { name: 'list_charges', effect: TOOL_EFFECT.READ },
        { name: 'create_refund', effect: TOOL_EFFECT.WRITE },
        { name: 'delete_customer', effect: TOOL_EFFECT.DESTRUCTIVE },
      ],
      wrapped: false,
      transport: 'stdio',
    },
    {
      name: 'github',
      grantedBy: '/home/dev/.claude.json',
      agentIds: ['claude-code'],
      tools: [],
      wrapped: true,
      transport: 'stdio',
    },
    // What onboarding writes: Memnox itself, governed by construction.
    {
      name: 'memnox',
      grantedBy: '/home/dev/.claude.json',
      agentIds: ['claude-code'],
      tools: [],
    },
  ],
};

const serverRows = () =>
  censusFrom(snapshot, { names: {}, declined: {} }).filter(
    (row) => row.kind === 'mcp.server.reported',
  );

describe('the census names every MCP server and whether it is governed', () => {
  it('sends one row per server with its counts', () => {
    const stripe = serverRows().find((row) => row.subjectId === 'stripe');

    expect(stripe?.payload).toEqual({
      server: 'stripe',
      agentIds: ['cursor'],
      governed: false,
      transport: 'stdio',
      toolCount: 3,
      writeToolCount: 2,
    });
  });

  it('counts a wrapped server and the Memnox entry as governed', () => {
    const governed = serverRows()
      .filter((row) => row.payload['governed'] === true)
      .map((row) => row.subjectId);

    expect(governed).toEqual(['github', 'memnox']);
  });

  it('keys a row per scan, so a later scan is not read as a resend', () => {
    const later = censusFrom(
      { ...snapshot, takenAt: '2026-09-02T09:00:00.000Z' },
      { names: {}, declined: {} },
    ).filter((row) => row.kind === 'mcp.server.reported');

    expect(later.map((row) => row.dedupKey)).not.toEqual(
      serverRows().map((row) => row.dedupKey),
    );
  });

  it('never carries a launch line, a path or an environment value', () => {
    const wire = JSON.stringify(serverRows());

    expect(wire).not.toContain('/home/dev');
    expect(wire).not.toContain('npx');
  });
});

const action: MemnoxEvent = {
  id: 'evt_spend',
  schemaVersion: EVENT_SCHEMA_VERSION,
  at: TAKEN_AT,
  sessionId: 'ses_spend',
  agent: 'claude-code',
  actorType: 'agent',
  surface: EVENT_SURFACE.SHELL,
  operation: 'shell.exec',
  class: 'read',
  effect: DECISION_EFFECT.ALLOW,
  mode: ENFORCEMENT_MODE.ENFORCE,
  reason: 'allowed',
  exitCode: 0,
};

describe('an action carries what it cost, only where the agent said', () => {
  it('sends the cost the agent reported', () => {
    expect(draftFrom({ ...action, costUsd: 0.42 }).payload['costUsd']).toBe(0.42);
  });

  it('sends nothing rather than zero when no cost was reported', () => {
    expect('costUsd' in draftFrom(action).payload).toBe(false);
  });
});

describe('a scoped rule reaches the gate with its scope', () => {
  const bundle: Bundle = {
    hash: 'h',
    policies: [],
    conditions: [],
    tags: [],
    rules: [
      {
        id: 'r1',
        policyHash: 'p',
        line: 1,
        domain: 'mcp',
        effect: DECISION_EFFECT.DENY,
        specificity: 4,
        match: 'mcp.*',
        targets: ['stripe'],
        unless: [{ agents: ['billing-bot'] }],
      },
      {
        id: 'r2',
        policyHash: 'p',
        line: 2,
        domain: 'git',
        effect: DECISION_EFFECT.ASK,
        specificity: 8,
        match: 'git.push',
      },
    ],
  };

  it('keeps targets and carve-outs, and leaves an unscoped rule as it was', () => {
    const document = documentFrom(bundle) as {
      policies: { match: Record<string, unknown> }[];
    };

    expect(document.policies[0]?.match).toEqual({
      actions: ['mcp.*'],
      targets: ['stripe'],
      unless: [{ agents: ['billing-bot'] }],
    });
    expect(document.policies[1]?.match).toEqual({ actions: ['git.push'] });
  });

  /* The control plane sends a narrowed allow under a match nothing asks for, so a runtime
     that ignores scope cannot read it as allowing everyone; this one uses the real one. */
  it('rules on the real pattern of a narrowed allow', () => {
    const narrowed: Bundle = {
      ...bundle,
      rules: [
        {
          id: 'r3',
          policyHash: 'p',
          line: 3,
          domain: 'git',
          effect: DECISION_EFFECT.ALLOW,
          specificity: 8,
          match: 'memnox.requires-scoped-rules',
          scopedMatch: 'git.push',
          agents: ['hermes'],
        },
      ],
    };
    const document = documentFrom(narrowed) as {
      policies: { match: Record<string, unknown> }[];
    };

    expect(document.policies[0]?.match).toEqual({
      actions: ['git.push'],
      agents: ['hermes'],
    });
  });
});
