import { EXTENSION_LANGUAGES, LANGUAGE, type Language } from './code-graph.constants';

const EXTENSION_SEPARATOR = '.';

/** Repo-relative posix path → language, by extension alone. No filesystem access. */
export function detectLanguage(filePath: string): Language {
  const lastDot = filePath.lastIndexOf(EXTENSION_SEPARATOR);
  if (lastDot < 0) return LANGUAGE.UNKNOWN;
  return EXTENSION_LANGUAGES[filePath.slice(lastDot).toLowerCase()] ?? LANGUAGE.UNKNOWN;
}
