import { describe, expect, it } from 'vitest';
import { FakeMachine } from './fake-machine';
import { findPolicyGaps, readRepositoryEvidence } from '../src/repository-evidence';
import { CONTROL_KIND, EVIDENCE_SOURCE } from '../src/discovery.constants';

const ROOT = '/work/payments-service';

const repository = (files: Record<string, string>): FakeMachine =>
  FakeMachine.from(files);

describe('what the repository already says about itself', () => {
  it('reads a stated rule verbatim, with the file and the line', async () => {
    const machine = repository({
      [`${ROOT}/AGENTS.md`]: [
        '# Conventions',
        '',
        'Services must reach data through a repository, never directly.',
        'The tests live beside the code.',
      ].join('\n'),
    });

    const evidence = await readRepositoryEvidence(machine, ROOT);

    expect(evidence.stated).toHaveLength(1);
    expect(evidence.stated[0]?.text).toBe(
      'Services must reach data through a repository, never directly.',
    );
    expect(evidence.stated[0]?.statedIn).toBe('AGENTS.md');
    expect(evidence.stated[0]?.line).toBe(3);
    expect(evidence.stated[0]?.source).toBe(EVIDENCE_SOURCE.AGENT_INSTRUCTIONS);
  });

  it('leaves prose alone: a line with no modal is not a rule', async () => {
    const machine = repository({
      [`${ROOT}/CLAUDE.md`]: 'This service handles invoices and their line items.',
    });

    const evidence = await readRepositoryEvidence(machine, ROOT);

    expect(evidence.stated).toEqual([]);
  });

  it('leaves a table row and a heading alone: neither is a sentence to follow', async () => {
    const machine = repository({
      [`${ROOT}/AGENTS.md`]: [
        '## Rules a change must not undo',
        '| readinessFor | never what a rule says about it |',
        'A service must never open a socket directly.',
      ].join('\n'),
    });

    const evidence = await readRepositoryEvidence(machine, ROOT);

    expect(evidence.stated.map((rule) => rule.line)).toEqual([3]);
  });

  it('ignores a modal inside a fenced example', async () => {
    const machine = repository({
      [`${ROOT}/AGENTS.md`]: [
        '```',
        'echo "you must not run this"',
        '```',
        'Credentials must stay out of the repository.',
      ].join('\n'),
    });

    const evidence = await readRepositoryEvidence(machine, ROOT);

    expect(evidence.stated.map((rule) => rule.line)).toEqual([4]);
  });

  it('reads decisions out of the directory a team keeps them in', async () => {
    const machine = repository({
      [`${ROOT}/docs/adr/023-repository-layer.md`]:
        '- Direct database access from a service is forbidden.',
    });

    const evidence = await readRepositoryEvidence(machine, ROOT);

    expect(evidence.stated[0]?.source).toBe(EVIDENCE_SOURCE.DECISION);
    expect(evidence.stated[0]?.text).toBe(
      'Direct database access from a service is forbidden.',
    );
  });

  it('names what it opened, so the tool that reads a team’s documents is readable', async () => {
    const machine = repository({
      [`${ROOT}/AGENTS.md`]: 'Nothing must ship on a Friday.',
    });

    const evidence = await readRepositoryEvidence(machine, ROOT);

    expect(evidence.read).toEqual([`${ROOT}/AGENTS.md`]);
  });

  it('counts a code-owners entry and a real hook as enforcement, not a sample', async () => {
    const machine = repository({
      [`${ROOT}/.github/CODEOWNERS`]: '# owners\n/src/payments @platform\n',
      [`${ROOT}/.git/hooks/pre-commit`]: '#!/bin/sh\nnpm test\n',
      [`${ROOT}/.git/hooks/pre-push.sample`]: '#!/bin/sh\n',
    });

    const evidence = await readRepositoryEvidence(machine, ROOT);

    expect(evidence.enforced).toEqual([
      {
        kind: CONTROL_KIND.CODE_OWNERS,
        statedIn: '.github/CODEOWNERS',
        detail: '/src/payments @platform',
      },
      {
        kind: CONTROL_KIND.GIT_HOOK,
        statedIn: '.git/hooks/pre-commit',
        detail: 'pre-commit runs before the commit lands',
      },
    ]);
  });
});

describe('the document against the system', () => {
  it('reports a documented review requirement that nothing here enforces', async () => {
    const machine = repository({
      [`${ROOT}/SECURITY.md`]: 'Production changes must carry two approvals.',
    });

    const gaps = findPolicyGaps(await readRepositoryEvidence(machine, ROOT));

    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.documented.text).toBe('Production changes must carry two approvals.');
    expect(gaps[0]?.enforcedBy).toEqual([]);
  });

  it('names what it could not read rather than implying the forge was checked', async () => {
    const machine = repository({
      [`${ROOT}/SECURITY.md`]: 'Production changes must be reviewed.',
    });

    const gaps = findPolicyGaps(await readRepositoryEvidence(machine, ROOT));

    expect(gaps[0]?.unread).toContain('not on this disk');
  });

  it('shows the control that answers the requirement where one exists', async () => {
    const machine = repository({
      [`${ROOT}/SECURITY.md`]: 'Production changes must be reviewed.',
      [`${ROOT}/CODEOWNERS`]: '/src @platform',
    });

    const gaps = findPolicyGaps(await readRepositoryEvidence(machine, ROOT));

    expect(gaps[0]?.enforcedBy).toHaveLength(1);
  });

  it('says nothing about a requirement no on-disk control could answer', async () => {
    const machine = repository({
      [`${ROOT}/AGENTS.md`]: 'Commit messages must be one line.',
    });

    const gaps = findPolicyGaps(await readRepositoryEvidence(machine, ROOT));

    expect(gaps).toEqual([]);
  });
});
