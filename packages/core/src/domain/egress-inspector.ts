/**
 * Cheap and certain only. Credential shapes and marked fields, never a general
 * classifier: a model on the hot path of every action is the first slow week away from
 * enforcement being switched off, and phase 09 is where probabilistic work belongs.
 */
export const CREDENTIAL_SHAPE = {
  AWS_ACCESS_KEY: 'aws access key id',
  PRIVATE_KEY: 'private key',
  JWT: 'json web token',
  GITHUB_TOKEN: 'github token',
  SLACK_TOKEN: 'slack token',
  BEARER: 'bearer credential',
  CONNECTION_STRING: 'database connection string',
} as const;

export type CredentialShape = (typeof CREDENTIAL_SHAPE)[keyof typeof CREDENTIAL_SHAPE];

/**
 * Assembled rather than written out, so this file never itself contains a string that
 * reads as somebody's key. Each is anchored on a prefix a real credential must carry.
 */
const SHAPES: readonly { shape: CredentialShape; pattern: RegExp }[] = [
  {
    shape: CREDENTIAL_SHAPE.AWS_ACCESS_KEY,
    pattern: new RegExp(`${'AKIA'}[0-9A-Z]{16}`),
  },
  {
    shape: CREDENTIAL_SHAPE.PRIVATE_KEY,
    pattern: new RegExp(`${'-----BEGIN'} [A-Z ]*${'PRIVATE KEY'}`),
  },
  {
    shape: CREDENTIAL_SHAPE.JWT,
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  },
  {
    shape: CREDENTIAL_SHAPE.GITHUB_TOKEN,
    pattern: new RegExp(`\\b${'gh'}[pousr]_[A-Za-z0-9]{20,}`),
  },
  {
    shape: CREDENTIAL_SHAPE.SLACK_TOKEN,
    pattern: new RegExp(`\\b${'xox'}[abprs]-[A-Za-z0-9-]{10,}`),
  },
  { shape: CREDENTIAL_SHAPE.BEARER, pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i },
  {
    shape: CREDENTIAL_SHAPE.CONNECTION_STRING,
    pattern: /\b(?:postgres|postgresql|mysql|mongodb)(?:\+srv)?:\/\/[^\s:@/]+:[^\s@/]+@/i,
  },
];

/** Field names whose value is a credential by declaration, whatever it looks like. */
const MARKED_FIELDS: readonly string[] = [
  'password',
  'secret',
  'token',
  'api_key',
  'apikey',
  'access_key',
  'private_key',
  'credential',
  'authorization',
  'session_key',
];

export interface EgressFinding {
  /** The field it was found in, so somebody can decide whether the rule is wrong. */
  field: string;
  shape: CredentialShape | 'marked field';
}

export interface EgressInspection {
  destination?: string;
  findings: EgressFinding[];
}

export interface EgressPayload {
  destination?: string;
  /** Field name to value. Flattened by the caller; nothing here reads a nested shape. */
  fields: Readonly<Record<string, string>>;
}

/**
 * Destination and payload, both: an allowed host carrying a credential is still a
 * refusal. Nothing is modified — silently stripping a payload is a bug the agent cannot
 * see and the reader cannot audit — so this reports and the caller decides.
 */
export function inspectEgress(payload: EgressPayload): EgressInspection {
  const findings: EgressFinding[] = [];

  for (const [field, value] of Object.entries(payload.fields)) {
    if (value.length === 0) continue;

    if (MARKED_FIELDS.includes(field.toLowerCase())) {
      findings.push({ field, shape: 'marked field' });
      continue;
    }
    const matched = SHAPES.find((candidate) => candidate.pattern.test(value));
    if (matched !== undefined) findings.push({ field, shape: matched.shape });
  }

  return {
    ...(payload.destination === undefined ? {} : { destination: payload.destination }),
    findings,
  };
}

/** The refusal names the field and never the value; the value stays where it was read. */
export function describeEgress(inspection: EgressInspection): string {
  const named = inspection.findings
    .map((finding) => `${finding.field} (${finding.shape})`)
    .join(', ');
  const where =
    inspection.destination === undefined ? '' : ` to ${inspection.destination}`;
  return `this payload${where} carries ${named}`;
}
