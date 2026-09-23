/**
 * What a session tool may hand back to the agent: clipped, capped, and with anything
 * shaped like a credential masked, because the answer lands in a model's context.
 */

/** One field, long enough for a rule's reason and short enough to never carry a file. */
export const MOST_FIELD_CHARS = 300;

/** Rows in any one list: a session's last steps, the rules that matched. */
export const MOST_ROWS = 40;

/** The whole answer, as text, whatever the tool. */
export const MOST_ANSWER_CHARS = 8_000;

const MASK = '[redacted]';

/** Credential shapes the ledger should never hold, masked again here in case one slipped in. */
const SECRET_SHAPES: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(password|passwd|secret|token|api[_-]?key)(\s*[=:]\s*)\S+/gi,
];

export function masked(text: string): string {
  return SECRET_SHAPES.reduce(
    (current, shape) =>
      current.replace(shape, (_match, name: unknown, joiner: unknown) =>
        typeof name === 'string' && typeof joiner === 'string'
          ? `${name}${joiner}${MASK}`
          : MASK,
      ),
    text,
  );
}

function clippedText(text: string): string {
  const safe = masked(text);
  if (safe.length <= MOST_FIELD_CHARS) return safe;
  return `${safe.slice(0, MOST_FIELD_CHARS)}... (cut)`;
}

/** Every string masked and clipped and every list capped, all the way down. */
export function bounded(value: unknown): unknown {
  if (typeof value === 'string') return clippedText(value);
  if (Array.isArray(value)) {
    const kept = value.slice(-MOST_ROWS).map(bounded);
    return value.length > MOST_ROWS
      ? [`${value.length - MOST_ROWS} earlier row(s) left out`, ...kept]
      : kept;
  }
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, each] of Object.entries(value)) out[key] = bounded(each);
  return out;
}

/** The answer as the agent reads it, never longer than the cap however much there was. */
export function answerText(value: unknown): string {
  const text = JSON.stringify(bounded(value), null, 2);
  if (text.length <= MOST_ANSWER_CHARS) return text;
  return `${text.slice(0, MOST_ANSWER_CHARS)}\n... (cut to ${MOST_ANSWER_CHARS} characters)`;
}
