/**
 * Text that leaves this machine with every credential in it masked. A command line is the
 * target when nothing narrower was parsed, so `vercel deploy --token=XYZ` would otherwise
 * reach the control plane, a DM and a screenshot with the token in it.
 */

export const REDACTED = '[redacted]';

/** Names that say their value is a secret, as a flag, a variable or a key. */
const SECRET_NAME =
  '[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|auth[_-]?token|authorization|session[_-]?key)[A-Za-z0-9_.-]*';

/** Credential shapes that are secrets whatever they are called. */
const SHAPES: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

/**
 * A quoted value runs to its closing quote on the same line, so a passphrase masks whole
 * rather than to its first space. The name is group 1, so the quote is always group 2.
 */
const QUOTED_VALUE = '(["\'])((?:(?!\\2)[^\\n])*)\\2';

/** `--token=XYZ`, `TOKEN=XYZ`, `"api_key": "XYZ"` and `password: XYZ`, the name kept. */
const NAMED_VALUE = new RegExp(
  `((?:^|[\\s"'{,;&|(])-{0,2}${SECRET_NAME}["']?\\s*[=:]\\s*)(?:${QUOTED_VALUE}|["']?([^\\s"',;&|)]+))`,
  'gi',
);

/** `--token XYZ` and `-p XYZ`, where the value is the next word. */
const FLAG_THEN_VALUE = new RegExp(
  `((?:^|\\s)--?${SECRET_NAME}\\s+)(?:${QUOTED_VALUE}|([^\\s-][^\\s]*))`,
  'gi',
);

/** `Authorization: Bearer XYZ` and `Basic XYZ`. */
const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

const SCHEME_WORDS: readonly string[] = ['bearer', 'basic', 'token'];

/** `https://user:secret@host`, where the password sits in the address itself. */
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;

/** Masks what a name introduced, keeping the name and the quotes that delimited it. */
function masked(
  whole: string,
  name: string,
  quote: string | undefined,
  value: string,
): string {
  // `Authorization: Bearer x` names its scheme here; the scheme's own rule masked the token.
  if (value === '' || SCHEME_WORDS.includes(value.toLowerCase()) || value === REDACTED)
    return whole;
  return quote === undefined
    ? `${name}${REDACTED}`
    : `${name}${quote}${REDACTED}${quote}`;
}

/** Whichever branch of the value alternation matched: the quoted body, or the bare word. */
function valueOf(
  quote: string | undefined,
  quoted: string | undefined,
  bare: string | undefined,
): string {
  return (quote === undefined ? bare : quoted) ?? '';
}

/** The text with every credential it carries masked, and nothing else changed. */
export function redactSecrets(text: string): string {
  let safe = text
    .replace(URL_PASSWORD, `$1${REDACTED}@`)
    .replace(AUTH_SCHEME, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(
      NAMED_VALUE,
      (whole, name: string, quote?: string, quoted?: string, bare?: string) =>
        masked(whole, name, quote, valueOf(quote, quoted, bare)),
    )
    .replace(
      FLAG_THEN_VALUE,
      (whole, name: string, quote?: string, quoted?: string, bare?: string) =>
        masked(whole, name, quote, valueOf(quote, quoted, bare)),
    );
  for (const shape of SHAPES) safe = safe.replace(shape, REDACTED);
  return safe;
}
