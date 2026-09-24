import { join } from 'node:path';
import { MEMNOX_HOME } from '../config/config';
import { BUDGET_UNIT, BUDGET_WINDOW, type Budget } from './budget';
import { readJsonArray, writeJsonFile } from '../store/json-records';

/**
 * Where budgets are kept, and the generous set a machine starts with, because a budget
 * that bites in week one gets deleted and a deleted budget catches nothing.
 */
const BUDGET_FILE = 'budgets.json';

export function budgetPathFor(home: string): string {
  return join(home, MEMNOX_HOME, BUDGET_FILE);
}

/** Empty is the default, and an empty book never refuses anything. */
export async function readBudgets(home: string): Promise<Budget[]> {
  return readJsonArray<Budget>(budgetPathFor(home));
}

export async function writeBudgets(
  home: string,
  budgets: readonly Budget[],
): Promise<void> {
  await writeJsonFile(budgetPathFor(home), budgets);
}

/** A starting set only a runaway reaches, since a budget is a signal rather than a quota. */
export function suggestedBudgets(): Budget[] {
  return [
    {
      name: 'production deploys',
      actions: ['deploy.*', '*.deploy', 'vercel.deploy-production'],
      limit: 5,
      window: BUDGET_WINDOW.DAY,
      unit: BUDGET_UNIT.CALLS,
    },
    {
      name: 'pull requests',
      actions: ['gh.pr-create', 'github.create*'],
      limit: 20,
      window: BUDGET_WINDOW.DAY,
      unit: BUDGET_UNIT.CALLS,
    },
    {
      name: 'outbound messages',
      actions: ['*.send*', 'email.*', 'slack.post*'],
      limit: 50,
      window: BUDGET_WINDOW.DAY,
      unit: BUDGET_UNIT.CALLS,
    },
    {
      name: 'database writes',
      actions: ['psql.*', 'mysql.*', 'mongosh.*'],
      limit: 500,
      window: BUDGET_WINDOW.DAY,
      unit: BUDGET_UNIT.CALLS,
    },
  ];
}
