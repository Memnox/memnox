import { scanContent, type ShieldFinding } from '@memnox/content-shield';

/** A synthetic path so the scanner's path routing treats this as generic text. */
const RESPONSE_PATH = 'model-output.txt';

export const OUTPUT_BLOCKED_MESSAGE = 'model output withheld: it contained credentials';

interface OutputVerdict {
  safe: boolean;
  /** Rules that matched, for the audit record — never the matched text itself. */
  rules: string[];
}

/**
 * Post-inference check: a model can echo a secret it was shown, and relaying
 * that would put it in the caller's logs. Scans only what the provider returned.
 */
export function inspectOutput(body: string): OutputVerdict {
  if (body.length === 0) return { safe: true, rules: [] };
  const findings: ShieldFinding[] = scanContent(RESPONSE_PATH, body);
  if (findings.length === 0) return { safe: true, rules: [] };
  return {
    safe: false,
    rules: [...new Set(findings.map((finding) => finding.rule))].sort(),
  };
}
