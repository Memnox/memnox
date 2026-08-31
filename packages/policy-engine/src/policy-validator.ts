import {
  DECISION_EFFECT,
  SCOPE_MATCH,
  type Alternative,
  type DecisionEffect,
  type RateLimitSpec,
  type ScopeMatch,
} from '@memnox/core';
import { isValidTimeWindow, type TimeWindow } from './time-window';
import type { Policy, PolicyDocument, PolicyMode } from './policy';
import { POLICY_DOCUMENT_VERSION, POLICY_MODE } from './policy';

const VALID_EFFECTS: readonly string[] = Object.values(DECISION_EFFECT);
const VALID_MODES: readonly string[] = Object.values(POLICY_MODE);

export class PolicyValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(
      `Invalid policy document:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
    this.name = 'PolicyValidationError';
  }
}

/** Validates a parsed document into a typed PolicyDocument, listing every issue. */
export function validatePolicyDocument(input: unknown): PolicyDocument {
  const issues: string[] = [];
  const doc = asRecord(input, 'document', issues);
  if (!doc) throw new PolicyValidationError(issues);

  if (doc['version'] !== POLICY_DOCUMENT_VERSION) {
    issues.push(`"version" must be ${POLICY_DOCUMENT_VERSION}`);
  }
  const project = validateProject(doc['project'], issues);

  const rawPolicies = Array.isArray(doc['policies']) ? doc['policies'] : null;
  if (!rawPolicies) issues.push('"policies" must be an array');

  const policies: Policy[] = [];
  const seenNames = new Set<string>();
  for (const [index, raw] of (rawPolicies ?? []).entries()) {
    const policy = validatePolicy(raw, `policies[${index}]`, issues);
    if (!policy) continue;
    if (seenNames.has(policy.name)) issues.push(`duplicate policy name "${policy.name}"`);
    seenNames.add(policy.name);
    policies.push(policy);
  }

  if (issues.length > 0) throw new PolicyValidationError(issues);
  return { version: POLICY_DOCUMENT_VERSION, project, policies };
}

/** A typo must be rejected: it would silently split one project into two scopes. */
function validateProject(input: unknown, issues: string[]): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'string' || input.trim().length === 0) {
    issues.push('"project" must be a non-empty string when present');
    return undefined;
  }
  return input.trim();
}

function validatePolicy(input: unknown, path: string, issues: string[]): Policy | null {
  const raw = asRecord(input, path, issues);
  if (!raw) return null;

  const name = asNonEmptyString(raw['name'], `${path}.name`, issues);
  const match = asRecord(raw['match'], `${path}.match`, issues);
  const decision = asRecord(raw['decision'], `${path}.decision`, issues);
  if (!name || !match || !decision) return null;

  const actions = asStringArray(match['actions'], `${path}.match.actions`, issues);
  if (!actions || actions.length === 0) {
    issues.push(`${path}.match.actions must be a non-empty string array`);
    return null;
  }

  const rawEffect = decision['effect'];
  if (typeof rawEffect !== 'string' || !VALID_EFFECTS.includes(rawEffect)) {
    issues.push(`${path}.decision.effect must be one of: ${VALID_EFFECTS.join(', ')}`);
    return null;
  }
  const effect = rawEffect as DecisionEffect;
  const approvers = asOptionalStringArray(
    decision['approvers'],
    `${path}.decision.approvers`,
    issues,
  );
  if (effect === DECISION_EFFECT.ESCALATE && (!approvers || approvers.length === 0)) {
    issues.push(
      `${path}.decision.approvers is required when effect is "${DECISION_EFFECT.ESCALATE}"`,
    );
  }

  return {
    name,
    description: typeof raw['description'] === 'string' ? raw['description'] : undefined,
    match: {
      actions,
      targets: asOptionalStringArray(match['targets'], `${path}.match.targets`, issues),
      environments: asOptionalStringArray(
        match['environments'],
        `${path}.match.environments`,
        issues,
      ),
      agents: asOptionalStringArray(match['agents'], `${path}.match.agents`, issues),
      principals: asOptionalStringArray(
        match['principals'],
        `${path}.match.principals`,
        issues,
      ),
      models: asOptionalStringArray(match['models'], `${path}.match.models`, issues),
      providers: asOptionalStringArray(
        match['providers'],
        `${path}.match.providers`,
        issues,
      ),
      dataClassifications: asOptionalStringArray(
        match['dataClassifications'],
        `${path}.match.dataClassifications`,
        issues,
      ),
      jurisdictions: asOptionalStringArray(
        match['jurisdictions'],
        `${path}.match.jurisdictions`,
        issues,
      ),
      workingDirectories: asOptionalStringArray(
        match['workingDirectories'],
        `${path}.match.workingDirectories`,
        issues,
      ),
      branches: asOptionalStringArray(
        match['branches'],
        `${path}.match.branches`,
        issues,
      ),
      arguments: asOptionalArgumentPatterns(
        match['arguments'],
        `${path}.match.arguments`,
        issues,
      ),
      aboveAmount: asOptionalThreshold(
        match['aboveAmount'],
        `${path}.match.aboveAmount`,
        issues,
      ),
      windows: asOptionalWindows(match['windows'], `${path}.match.windows`, issues),
      scope: asOptionalScope(match['scope'], `${path}.match.scope`, issues),
      state: asOptionalStringArray(match['state'], `${path}.match.state`, issues),
    },
    decision: {
      effect,
      reason: typeof decision['reason'] === 'string' ? decision['reason'] : undefined,
      approvers,
      minApprovals: asOptionalQuorum(
        decision['minApprovals'],
        `${path}.decision.minApprovals`,
        issues,
      ),
      mode: asOptionalMode(decision['mode'], `${path}.decision.mode`, issues),
      rateLimit: asOptionalRateLimit(
        decision['rateLimit'],
        `${path}.decision.rateLimit`,
        issues,
      ),
      alternative: asOptionalAlternative(
        decision['alternative'],
        `${path}.decision.alternative`,
        issues,
      ),
    },
  };
}

const VALID_SCOPE_MATCHES = Object.values(SCOPE_MATCH);

/** A rule matches on how the request sat against the declared scope, never on a guess. */
function asOptionalScope(
  input: unknown,
  path: string,
  issues: string[],
): ScopeMatch[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input) || input.length === 0) {
    issues.push(`${path} must be a non-empty array`);
    return undefined;
  }
  const invalid = input.filter(
    (entry) =>
      typeof entry !== 'string' || !(VALID_SCOPE_MATCHES as string[]).includes(entry),
  );
  if (invalid.length > 0) {
    issues.push(`${path} entries must be one of: ${VALID_SCOPE_MATCHES.join(', ')}`);
    return undefined;
  }
  return input as ScopeMatch[];
}

/**
 * The substitute the rule permits. A refusal that names one gets taken; the note is
 * required because "use something else" is not an instruction an agent can act on.
 */
function asOptionalAlternative(
  input: unknown,
  path: string,
  issues: string[],
): Alternative | undefined {
  if (input === undefined || input === null) return undefined;
  const raw = asRecord(input, path, issues);
  if (!raw) return undefined;
  const action = raw['action'];
  const note = raw['note'];
  const resource = raw['resource'];
  if (typeof action !== 'string' || action.length === 0) {
    issues.push(`${path}.action is required`);
    return undefined;
  }
  if (typeof note !== 'string' || note.length === 0) {
    issues.push(`${path}.note is required — it is what the agent reads`);
    return undefined;
  }
  if (resource !== undefined && typeof resource !== 'string') {
    issues.push(`${path}.resource must be a string`);
    return undefined;
  }
  return { action, note, ...(resource === undefined ? {} : { resource }) };
}

/** Argument patterns are a map of argument name to the wildcards it must match. */
function asOptionalArgumentPatterns(
  input: unknown,
  path: string,
  issues: string[],
): Record<string, string[]> | undefined {
  if (input === undefined || input === null) return undefined;
  const raw = asRecord(input, path, issues);
  if (!raw) return undefined;

  const entries = Object.entries(raw);
  if (entries.length === 0) {
    issues.push(`${path} must name at least one argument`);
    return undefined;
  }
  const patterns: Record<string, string[]> = {};
  for (const [name, value] of entries) {
    const list = asStringArray(value, `${path}.${name}`, issues);
    if (!list) continue;
    if (list.length === 0) {
      issues.push(`${path}.${name} must be a non-empty string array`);
      continue;
    }
    patterns[name] = list;
  }
  return Object.keys(patterns).length === 0 ? undefined : patterns;
}

function asOptionalMode(
  input: unknown,
  path: string,
  issues: string[],
): PolicyMode | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'string' || !VALID_MODES.includes(input)) {
    issues.push(`${path} must be one of: ${VALID_MODES.join(', ')}`);
    return undefined;
  }
  return input as PolicyMode;
}

function asOptionalRateLimit(
  input: unknown,
  path: string,
  issues: string[],
): RateLimitSpec | undefined {
  if (input === undefined || input === null) return undefined;
  const raw = asRecord(input, path, issues);
  if (!raw) return undefined;

  const max = raw['max'];
  const windowSeconds = raw['windowSeconds'];
  if (!isPositiveInteger(max) || !isPositiveInteger(windowSeconds)) {
    issues.push(`${path} must be { max, windowSeconds } with positive integers`);
    return undefined;
  }
  return { max, windowSeconds };
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function asOptionalWindows(
  input: unknown,
  path: string,
  issues: string[],
): TimeWindow[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length === 0) {
    issues.push(`${path} must be a non-empty array`);
    return undefined;
  }
  const windows = input as TimeWindow[];
  const invalid = windows.findIndex((window) => !isValidTimeWindow(window));
  if (invalid >= 0) {
    issues.push(
      `${path}[${invalid}] needs startHour 0-23, endHour 1-24, and days 0-6 when present`,
    );
    return undefined;
  }
  return windows;
}

function asOptionalQuorum(
  input: unknown,
  path: string,
  issues: string[],
): number | undefined {
  if (input === undefined) return undefined;
  if (!Number.isInteger(input) || (input as number) < 1) {
    issues.push(`${path} must be an integer of at least 1`);
    return undefined;
  }
  return input as number;
}

/** Any finite non-negative size: policies are written about hours and rates too. */
function asOptionalThreshold(
  input: unknown,
  path: string,
  issues: string[],
): number | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) {
    issues.push(`${path} must be a number of at least 0`);
    return undefined;
  }
  return input;
}

function asRecord(
  input: unknown,
  path: string,
  issues: string[],
): Record<string, unknown> | null {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  issues.push(`${path} must be an object`);
  return null;
}

function asNonEmptyString(input: unknown, path: string, issues: string[]): string | null {
  if (typeof input === 'string' && input.trim().length > 0) return input.trim();
  issues.push(`${path} must be a non-empty string`);
  return null;
}

function asStringArray(input: unknown, path: string, issues: string[]): string[] | null {
  if (Array.isArray(input) && input.every((item) => typeof item === 'string')) {
    return input as string[];
  }
  issues.push(`${path} must be a string array`);
  return null;
}

function asOptionalStringArray(
  input: unknown,
  path: string,
  issues: string[],
): string[] | undefined {
  if (input === undefined || input === null) return undefined;
  return asStringArray(input, path, issues) ?? undefined;
}
