import { execFileSync } from 'node:child_process';

const ENV_DIFF_BASE = 'MEMNOX_DIFF_BASE';
const DEFAULT_DIFF_BASE = 'HEAD~1';
const DIFF_MAX_BUFFER = 16 * 1024 * 1024;

export const DIFF_BASE_HELP = `git ref to diff against (default: $${ENV_DIFF_BASE} or ${DEFAULT_DIFF_BASE})`;

export interface DiffSelection {
  base?: string;
  staged?: boolean;
}

/** Where `memnox ci` gets the changes it scans. Injected so tests supply a diff directly. */
export type DiffSource = (selection: DiffSelection) => string;

export const gitDiff: DiffSource = (selection) => {
  const args = selection.staged
    ? ['diff', '--cached', '--unified=0']
    : [
        'diff',
        selection.base ?? process.env[ENV_DIFF_BASE] ?? DEFAULT_DIFF_BASE,
        '--unified=0',
      ];
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: DIFF_MAX_BUFFER });
};
