import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MEMNOX_HOME } from '../config/config';
import { BUDGET_UNIT, BUDGET_WINDOW, type Budget } from './budget';

const BUDGET_FILE = 'budgets.json';

export function budgetPathFor(home: string): string {
  return join(home, MEMNOX_HOME, BUDGET_FILE);
}

/** Empty is the default, and an empty book never refuses anything. */
export async function readBudgets(home: string): Promise<Budget[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(budgetPathFor(home), 'utf8'));
    return Array.isArray(parsed) ? (parsed as Budget[]) : [];
  } catch {
    // Nobody has set a budget here, which is the ordinary case.
    return [];
  }
}

export async function writeBudgets(home: string, budgets: Budget[]): Promise<void> {
  const path = budgetPathFor(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(budgets, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

/**
 * A starting set, from what a scan already found.
 *
 * Deliberately generous. A budget is a signal that something has gone wrong, not a
 * quota somebody has to plan around, so the first numbers are far above a normal day
 * and only a runaway reaches them. A budget that bites in week one gets deleted.
 */
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
