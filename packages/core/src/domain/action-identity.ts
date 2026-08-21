import type { ActionRequest } from './action-event';

/** Characters that are invisible or can reorder what a policy author sees. */
const INVISIBLE =
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/** Identity fields only: rewriting `arguments` would rule on a command nobody runs. */
const IDENTITY_FIELDS = [
  'action',
  'target',
  'environment',
  'principal',
  'model',
  'provider',
  'dataClassification',
  'jurisdiction',
  'workingDirectory',
  'branch',
] as const satisfies ReadonlyArray<keyof ActionRequest>;

/** One name, one verdict: a trailing space, tab, or zero-width char was a policy bypass. */
export function normalizeActionField(value: string): string {
  return value.replace(INVISIBLE, '').trim();
}

/** Canonicalizes every field policy is matched on, leaving payloads untouched. */
export function normalizeActionRequest(request: ActionRequest): ActionRequest {
  const normalized = { ...request };
  for (const field of IDENTITY_FIELDS) {
    const value = normalized[field];
    if (value === undefined) continue;
    normalized[field] = normalizeActionField(value);
  }
  return normalized;
}
