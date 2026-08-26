import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import type { ActionRequest } from '@memnox/core';

const ACTION_PLAN_VERSION = 1;

interface ActionPlan {
  version: number;
  actions: ActionRequest[];
}

/** Every issue at once: a plan is edited by hand, and one error per run is a slog. */
export class ActionPlanError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid action plan:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ActionPlanError';
  }
}

/** A typo'd key that silently changes a verdict is the failure this list prevents. */
const STRING_FIELDS = [
  'action',
  'target',
  'environment',
  'principal',
  'reason',
  'model',
  'provider',
  'dataClassification',
  'jurisdiction',
  'workingDirectory',
  'branch',
] as const;

const NUMBER_FIELDS = ['amount'] as const;

const KNOWN_FIELDS: readonly string[] = [...STRING_FIELDS, ...NUMBER_FIELDS];

export async function loadActionPlan(filePath: string): Promise<ActionPlan> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    // A bare ENOENT names neither the path the flag resolved to nor the fix.
    if (isMissingFile(err)) {
      throw new Error(
        `No plan at ${filePath} — a plan is "version: 1" and an "actions:" list.`,
      );
    }
    throw err;
  }
  return parseActionPlan(parse(raw));
}

export function parseActionPlan(document: unknown): ActionPlan {
  const issues: string[] = [];
  const record = asRecord(document);
  if (record === null) {
    throw new ActionPlanError(['the plan must be a mapping with an "actions" list']);
  }

  const version = record['version'];
  if (version !== undefined && version !== ACTION_PLAN_VERSION) {
    issues.push(
      `unsupported version ${String(version)} — expected ${ACTION_PLAN_VERSION}`,
    );
  }

  const entries = record['actions'];
  if (!Array.isArray(entries)) {
    throw new ActionPlanError([...issues, '"actions" must be a list']);
  }

  const actions: ActionRequest[] = [];
  entries.forEach((entry, index) => {
    const parsed = parseEntry(entry, index, issues);
    if (parsed !== null) actions.push(parsed);
  });

  if (issues.length > 0) throw new ActionPlanError(issues);
  return { version: ACTION_PLAN_VERSION, actions };
}

function parseEntry(
  entry: unknown,
  index: number,
  issues: string[],
): ActionRequest | null {
  const where = `actions[${index}]`;
  const record = asRecord(entry);
  if (record === null) {
    issues.push(`${where} must be a mapping`);
    return null;
  }

  for (const key of Object.keys(record)) {
    if (!KNOWN_FIELDS.includes(key)) issues.push(`${where}: unknown field "${key}"`);
  }

  const request: Record<string, unknown> = {};
  for (const field of STRING_FIELDS) {
    const value = record[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length === 0) {
      issues.push(`${where}.${field} must be a non-empty string`);
      continue;
    }
    request[field] = value;
  }
  for (const field of NUMBER_FIELDS) {
    const value = record[field];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      issues.push(`${where}.${field} must be a number`);
      continue;
    }
    request[field] = value;
  }

  if (request['action'] === undefined) {
    issues.push(`${where}.action is required`);
    return null;
  }
  return request as unknown as ActionRequest;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isMissingFile(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}
