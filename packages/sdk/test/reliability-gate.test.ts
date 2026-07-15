import { describe, expect, it, vi } from 'vitest';
import { EXECUTION_STATUS } from '@memnox/core';
import { runGuarded, toOutcomeReport, type Condition } from '../src/reliability-gate';

const holds = (description: string): Condition => ({
  description,
  check: async () => true,
});

const fails = (description: string): Condition => ({
  description,
  check: async () => false,
});

const throws = (description: string): Condition => ({
  description,
  check: async () => {
    throw new Error('check exploded');
  },
});

describe('runGuarded — the happy path', () => {
  it('runs the action and returns its result when every condition holds', async () => {
    const outcome = await runGuarded({
      preconditions: [holds('branch exists')],
      postconditions: [holds('PR was created')],
      execute: async () => 'pr-42',
    });

    expect(outcome.status).toBe(EXECUTION_STATUS.SUCCEEDED);
    expect(outcome.result).toBe('pr-42');
    expect(outcome.rolledBack).toBe(false);
  });
});

describe('runGuarded — preconditions', () => {
  it('never runs the action when a precondition fails', async () => {
    const execute = vi.fn(async () => 'never');
    const outcome = await runGuarded({
      preconditions: [holds('branch exists'), fails('file is unmodified')],
      execute,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(outcome.status).toBe(EXECUTION_STATUS.PRECONDITION_FAILED);
    expect(outcome.failedCondition).toBe('file is unmodified');
  });

  it('treats a throwing condition as one that did not hold', async () => {
    const outcome = await runGuarded({
      preconditions: [throws('remote is reachable')],
      execute: async () => 'never',
    });
    expect(outcome.status).toBe(EXECUTION_STATUS.PRECONDITION_FAILED);
    expect(outcome.failedCondition).toBe('remote is reachable');
  });

  it('does not roll back, because nothing ran', async () => {
    const rollback = vi.fn(async () => {});
    const outcome = await runGuarded({
      preconditions: [fails('branch exists')],
      rollback: { description: 'delete branch', execute: rollback },
      execute: async () => 'never',
    });
    expect(rollback).not.toHaveBeenCalled();
    expect(outcome.rolledBack).toBe(false);
  });
});

describe('runGuarded — postconditions', () => {
  it('rolls back when the action ran but did not verify', async () => {
    const rollback = vi.fn(async () => {});
    const outcome = await runGuarded({
      postconditions: [fails('tests pass on the new commit')],
      rollback: { description: 'revert commit', execute: rollback },
      execute: async () => 'commit-abc',
    });

    expect(rollback).toHaveBeenCalledOnce();
    expect(outcome.status).toBe(EXECUTION_STATUS.POSTCONDITION_FAILED);
    expect(outcome.failedCondition).toBe('tests pass on the new commit');
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.result).toBeUndefined();
  });

  it('reports rollbackError when the repair itself fails', async () => {
    const outcome = await runGuarded({
      postconditions: [fails('tests pass')],
      rollback: {
        description: 'revert commit',
        execute: async () => {
          throw new Error('force push rejected');
        },
      },
      execute: async () => 'commit-abc',
    });

    expect(outcome.rolledBack).toBe(false);
    expect(outcome.rollbackError).toBe('force push rejected');
  });

  it('leaves state unverified when no rollback was supplied', async () => {
    const outcome = await runGuarded({
      postconditions: [fails('tests pass')],
      execute: async () => 'commit-abc',
    });
    expect(outcome.status).toBe(EXECUTION_STATUS.POSTCONDITION_FAILED);
    expect(outcome.rolledBack).toBe(false);
    expect(outcome.rollbackError).toBeUndefined();
  });
});

describe('runGuarded — a throwing action', () => {
  it('rolls back and captures the error rather than propagating it', async () => {
    const rollback = vi.fn(async () => {});
    const outcome = await runGuarded({
      rollback: { description: 'revert', execute: rollback },
      execute: async () => {
        throw new Error('github 500');
      },
    });

    expect(outcome.status).toBe(EXECUTION_STATUS.EXECUTION_FAILED);
    expect(outcome.error).toBe('github 500');
    expect(rollback).toHaveBeenCalledOnce();
    expect(outcome.rolledBack).toBe(true);
  });
});

describe('toOutcomeReport', () => {
  it('carries the decision id and omits fields the request did not set', () => {
    const report = toOutcomeReport(
      { eventId: 'evt-1' } as never,
      { action: 'code.modify', target: 'src/a.ts' },
      {
        status: EXECUTION_STATUS.SUCCEEDED,
        rolledBack: false,
        durationMs: 12,
      },
    );

    expect(report).toEqual({
      decisionEventId: 'evt-1',
      action: 'code.modify',
      target: 'src/a.ts',
      status: EXECUTION_STATUS.SUCCEEDED,
      rolledBack: false,
      durationMs: 12,
    });
    expect('environment' in report).toBe(false);
  });
});
