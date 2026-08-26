import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ActionPlanError,
  loadActionPlan,
  parseActionPlan,
} from '../src/action-plan-file';

const DIR = mkdtempSync(join(tmpdir(), 'memnox-plan-'));

describe('action plan file', () => {
  it('reads the actions a plan names', () => {
    const plan = parseActionPlan({
      version: 1,
      actions: [
        { action: 'database.migrate', target: 'production', environment: 'production' },
        { action: 'file.write', target: 'src/index.ts' },
      ],
    });

    expect(plan.actions).toEqual([
      { action: 'database.migrate', target: 'production', environment: 'production' },
      { action: 'file.write', target: 'src/index.ts' },
    ]);
  });

  it('rejects a misspelled field rather than silently dropping it', () => {
    expect(() =>
      parseActionPlan({
        actions: [{ action: 'deploy.release', enviroment: 'production' }],
      }),
    ).toThrow(/unknown field "enviroment"/);
  });

  it('reports every issue at once', () => {
    try {
      parseActionPlan({ actions: [{ target: 'x' }, { action: 3 }] });
      expect.unreachable('an invalid plan must throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ActionPlanError);
      expect((err as ActionPlanError).issues).toHaveLength(3);
    }
  });

  it('refuses a version it does not understand', () => {
    expect(() => parseActionPlan({ version: 2, actions: [] })).toThrow(
      /unsupported version 2/,
    );
  });

  it('requires an actions list', () => {
    expect(() => parseActionPlan({ version: 1 })).toThrow(/"actions" must be a list/);
  });

  it('keeps a numeric amount as a number', () => {
    const plan = parseActionPlan({
      actions: [{ action: 'payment.refund', amount: 4200 }],
    });

    expect(plan.actions[0]).toEqual({ action: 'payment.refund', amount: 4200 });
  });

  it('loads a YAML plan from disk', async () => {
    const file = join(DIR, 'plan.yaml');
    writeFileSync(
      file,
      'version: 1\nactions:\n  - action: deploy.release\n    environment: production\n',
    );

    const plan = await loadActionPlan(file);

    expect(plan.actions).toEqual([
      { action: 'deploy.release', environment: 'production' },
    ]);
  });

  it('says what a plan is when the file is not there', async () => {
    await expect(loadActionPlan(join(DIR, 'missing.yaml'))).rejects.toThrow(
      /No plan at .*missing.yaml/,
    );
  });
});
