export const PATH_KIND = {
  CODE: 'code',
  MANIFEST: 'manifest',
  LOCK_FILE: 'lock-file',
  ENV_FILE: 'env-file',
  MINIFIED: 'minified',
  SAMPLE_FILE: 'sample-file',
} as const;

export type PathKind = (typeof PATH_KIND)[keyof typeof PATH_KIND];

/** Docs, templates and fixtures are expected to carry credential-shaped text. */
const SAMPLE_FILE_PATTERN =
  /\.(?:example|sample|template|md)$|(^|\/)\.env\.(?:example|sample|template)$|(^|\/)(?:fixtures?|__mocks__)\//i;
/** Bundled output is one enormous line — scanning it is all noise. */
const MINIFIED_PATTERN = /\.min\.(?:js|css)$/;
const MANIFEST_PATTERN = /(^|\/)package\.json$/;
const LOCK_FILE_PATTERN = /(^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;
const ENV_FILE_PATTERN = /(^|\/)\.env(?:\.[^/]+)?$/;

/** Decides which rule family a file gets — order matters, sample/minified win over everything. */
export function classifyPath(filePath: string): PathKind {
  if (SAMPLE_FILE_PATTERN.test(filePath)) return PATH_KIND.SAMPLE_FILE;
  if (MINIFIED_PATTERN.test(filePath)) return PATH_KIND.MINIFIED;
  if (MANIFEST_PATTERN.test(filePath)) return PATH_KIND.MANIFEST;
  if (LOCK_FILE_PATTERN.test(filePath)) return PATH_KIND.LOCK_FILE;
  if (ENV_FILE_PATTERN.test(filePath)) return PATH_KIND.ENV_FILE;
  return PATH_KIND.CODE;
}

export function isSkippedPath(kind: PathKind): boolean {
  return kind === PATH_KIND.SAMPLE_FILE || kind === PATH_KIND.MINIFIED;
}
