import { DECISION_EFFECT, type DecisionEffect } from '@memnox/core';
import { isValidTimeWindow, type TimeWindow } from './time-window';
import type { Policy, PolicyDocument } from './policy';
import { POLICY_DOCUMENT_VERSION } from './policy';

const VALID_EFFECTS: readonly string[] = Object.values(DECISION_EFFECT);

export class PolicyValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(
      `Invalid policy document:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
    this.name = 'PolicyValidationError';
  }
}

/** Validates a parsed (YAML/JSON) document into a typed PolicyDocument. Throws with every issue listed. */
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

/**
 * The project is an identifier repositories agree on by hand, so a typo must be
 * rejected rather than silently splitting one project into two scopes.
 */
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
  if (
    effect === DECISION_EFFECT.REQUIRE_APPROVAL &&
    (!approvers || approvers.length === 0)
  ) {
    issues.push(
      `${path}.decision.approvers is required when effect is "${DECISION_EFFECT.REQUIRE_APPROVAL}"`,
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
      windows: asOptionalWindows(match['windows'], `${path}.match.windows`, issues),
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
    },
  };
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
