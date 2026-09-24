import { homedir } from 'node:os';

import type { Command } from 'commander';

import { LEDGER_SCAN_LIMIT } from '@memnox/core';
import {
  BUDGET_UNIT,
  BUDGET_WINDOW,
  describeSpend,
  readBudgets,
  spendReport,
  suggestedBudgets,
  validateBudget,
  writeBudgets,
  type Budget,
  type BudgetUnit,
  type BudgetWindow,
  type EventQuery,
} from '@memnox/core';

import type { CliContext } from '../cli-context';
import { TONE } from '../flow';
import { withEvents } from '../event-store';

/**
 * `memnox budget`: how much an agent may do in a window, as against what it may do,
 * which catches a loop every single call was entitled to make. Counted from the
 * ledger, so it survives a restart.
 */

/** What every `memnox budget` subcommand needs. */
interface BudgetDeps {
  context: CliContext;
  home: () => string;
  now: () => Date;
}

export function registerBudgetCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
  now: () => Date = () => new Date(),
): void {
  const deps: BudgetDeps = { context, home, now };
  const budget = program
    .command('budget')
    .description('What an agent may spend in a window, and what it has spent');

  budget
    .command('list', { isDefault: true })
    .description('What is set, and how much is left')
    .option('--session <id>', 'count a session budget against this session')
    .action(async (options: { session?: string }) => runList(deps, options.session));

  budget
    .command('set <name>')
    .description('Add or replace one budget')
    .requiredOption('--actions <patterns>', 'action patterns it covers, comma separated')
    .requiredOption('--limit <n>', 'how much')
    .option('--window <window>', 'day, hour or session', BUDGET_WINDOW.DAY)
    .option('--unit <unit>', 'calls or usd', BUDGET_UNIT.CALLS)
    .action(async (name: string, options: SetOptions) => runSet(deps, name, options));

  budget
    .command('remove <name>')
    .description('Drop one budget')
    .action(async (name: string) => runRemove(deps, name));

  budget
    .command('suggest')
    .description('Write a generous starting set')
    .option('--yes', 'write them without asking')
    .action(async (options: { yes?: boolean }) => runSuggest(deps, options.yes === true));
}

/** What is set, and how much of each is left. */
async function runList(deps: BudgetDeps, session: string | undefined): Promise<void> {
  const { context, home, now } = deps;
  const { flow } = context;
  flow.open('memnox budget');

  const budgets = await readBudgets(home());
  if (budgets.length === 0) {
    flow.close('No budgets are set.');
    flow.hint('"memnox budget suggest" writes a generous starting set.');
    return;
  }

  const filter: EventQuery = { limit: LEDGER_SCAN_LIMIT };
  const events = await withEvents(home(), (store) => store.query(filter));
  const report = spendReport(budgets, {
    events,
    now: now().toISOString(),
    sessionId: session,
  });

  flow.list(
    'In force',
    report.map((spend) => ({
      tone: spend.remaining === 0 ? TONE.WARN : TONE.PLAIN,
      text: describeSpend(spend),
    })),
  );
  const spent = report.filter((spend) => spend.remaining === 0).length;
  flow.close(
    spent === 0
      ? `${report.length} budget(s), none of them spent.`
      : context.style.warn(`${spent} of ${report.length} budget(s) are spent.`),
  );
  flow.hint('Change one with "memnox budget set <name>".');
}

interface SetOptions {
  actions: string;
  limit: string;
  window: string;
  unit: string;
}

/** Adds one budget, or replaces the one of that name. */
async function runSet(
  deps: BudgetDeps,
  name: string,
  options: SetOptions,
): Promise<void> {
  const { context, home } = deps;
  const { flow } = context;
  flow.open('memnox budget set');

  const entry: Budget = {
    name,
    actions: options.actions
      .split(',')
      .map((each) => each.trim())
      .filter((each) => each.length > 0),
    limit: Number(options.limit),
    window: asWindow(options.window),
    unit: asUnit(options.unit),
  };
  const problems = validateBudget(entry);
  if (problems.length > 0) throw new Error(problems.join('\n'));

  const budgets = (await readBudgets(home())).filter((each) => each.name !== name);
  await writeBudgets(home(), [...budgets, entry]);

  flow.rows(name, [
    { label: 'covers', value: entry.actions.join(', ') },
    { label: 'limit', value: `${entry.limit} ${entry.unit} per ${entry.window}` },
  ]);
  flow.close(`"${name}" is set.`);
  if (entry.unit === BUDGET_UNIT.USD) {
    // This machine sees a command run, not what the model behind it charged.
    flow.hint(
      'A dollar budget counts only cost something reports; this machine cannot price a model call.',
    );
  }
  flow.hint('Drop it with "memnox budget remove".');
}

/** Drops one budget by name. */
async function runRemove(deps: BudgetDeps, name: string): Promise<void> {
  const { context, home } = deps;
  const { flow } = context;
  flow.open('memnox budget remove');

  const budgets = await readBudgets(home());
  const kept = budgets.filter((each) => each.name !== name);
  if (kept.length === budgets.length) throw new Error(`No budget called "${name}".`);
  await writeBudgets(home(), kept);
  flow.close(`Removed "${name}". ${kept.length} budget(s) left.`);
}

/** Proposes a generous starting set, and writes it when asked to. */
async function runSuggest(deps: BudgetDeps, write: boolean): Promise<void> {
  const { context, home } = deps;
  const { flow } = context;
  flow.open('memnox budget suggest');

  const suggested = suggestedBudgets();
  flow.table(
    write ? 'Writing' : 'Proposed',
    ['Budget', 'Limit'],
    suggested.map((each) => [each.name, `${each.limit} ${each.unit} per ${each.window}`]),
  );
  if (!write) {
    flow.close('Nothing was written.');
    flow.hint('Add --yes to write these to ~/.memnox/budgets.json.');
    return;
  }

  const existing = await readBudgets(home());
  const names = new Set(existing.map((each) => each.name));
  const added = suggested.filter((each) => !names.has(each.name));
  await writeBudgets(home(), [...existing, ...added]);
  flow.close(`Wrote ${added.length} budget(s).`);
  // Deliberately far above a normal day: one that bites in week one gets deleted.
  flow.hint('These are set high on purpose; only a runaway reaches them.');
}

function asWindow(value: string): BudgetWindow {
  // Widened so a typed flag can be looked up among the literal values.
  const windows = Object.values(BUDGET_WINDOW) as string[];
  if (!windows.includes(value)) {
    throw new Error(`--window takes one of: ${windows.join(', ')}`);
  }
  // Safe: the line above proved it is one of the values.
  return value as BudgetWindow;
}

function asUnit(value: string): BudgetUnit {
  // Widened so a typed flag can be looked up among the literal values.
  const units = Object.values(BUDGET_UNIT) as string[];
  if (!units.includes(value)) {
    throw new Error(`--unit takes one of: ${units.join(', ')}`);
  }
  // Safe: the line above proved it is one of the values.
  return value as BudgetUnit;
}
