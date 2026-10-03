/**
 * What a shell command wrote, read after it ran, since `perl -pi` shows nothing beforehand:
 * the tree kept before is compared after, and a forbidden line it added is told to put right.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  checksBreakingExisting,
  DECISION_EFFECT,
  JsonRecordDir,
  MEMNOX_HOME,
  ownProcessEnv,
  readCodeFingerprint,
  type BrokenCheck,
  type CodeFingerprint,
  type ExistingFile,
} from '@memnox/core';

import type { EditHookContext } from './edit-claims';
import { fieldsOf } from './hook-payload';
import { repositoryRootOf } from './seam-runtime';
import type { ToolAnswer } from './tool-hook';

/** The tree a command started from, kept until the host says the command returned. */
interface KeptTree {
  root: string;
  tree: string;
}

const KEPT_DIR = 'shell-trees';

/** Past this, a diff is a generated or vendored rewrite, and no convention is read from it. */
const MOST_DIFF_BYTES = 16 * 1024 * 1024;

/** Before an allowed command runs where a fingerprint enforces something: its tree, kept. */
export async function keepBeforeShell(
  payload: unknown,
  ruled: ToolAnswer,
  context: EditHookContext,
): Promise<void> {
  const { call, ruling } = ruled;
  if (call.shell === undefined || ruling.effect !== DECISION_EFFECT.ALLOW) return;
  const id = callKey(payload, context.runSession ?? call.sessionId);
  const root = repositoryRootOf(call.cwd ?? context.cwd);
  if (id === null || root === null || !(await enforces(root))) return;
  const tree = treeOf(root, context.home);
  if (tree !== null) await keptFor(context.home).write(id, { root, tree });
}

/** After it returned: what it added that the fingerprint forbids, said to put right, or null. */
export async function brokenByShell(
  payload: unknown,
  context: EditHookContext,
  sessionId: string,
): Promise<string | null> {
  const kept = keptFor(context.home);
  const found = await keptTree(kept, payload, sessionId);
  if (found === null) return null;
  const { id, before } = found;
  await kept.remove(id);
  const fingerprint = await readCodeFingerprint(before.root).catch(() => null);
  if (fingerprint === null || fingerprint.checks.length === 0) return null;
  const after = treeOf(before.root, context.home);
  if (after === null || after === before.tree) return null;
  const added = addedLines(before.root, before.tree, after, context.home);
  const broken = checksBreakingExisting(fingerprint, before.root, added);
  return broken.length === 0 ? null : putRight(broken, fingerprint);
}

async function enforces(root: string): Promise<boolean> {
  const fingerprint = await readCodeFingerprint(root).catch(() => null);
  return fingerprint !== null && fingerprint.checks.length > 0;
}

/**
 * The working tree as git would commit it, written through an index of its own so the
 * person's index, stash and branches are never touched; ignored files stay out.
 */
function treeOf(root: string, home: string): string | null {
  const scratch = mkdtempSync(join(tmpdir(), 'memnox-tree-'));
  const index = join(scratch, 'index');
  try {
    // Seeded from the real index, so git only rehashes what changed since it was written.
    const real = git(root, home, ['rev-parse', '--git-path', 'index']).trim();
    try {
      copyFileSync(resolve(root, real), index);
    } catch {
      // A repository nothing has been added to yet has no index, and starts from none.
    }
    const env = { GIT_INDEX_FILE: index };
    git(root, home, ['add', '-A', '--', '.'], env);
    return git(root, home, ['write-tree'], env).trim();
  } catch {
    return null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Each file the command changed, with only the lines it added, as a check reads them. */
function addedLines(
  root: string,
  before: string,
  after: string,
  home: string,
): ExistingFile[] {
  const diff = git(root, home, [
    '-c',
    'core.quotepath=off',
    'diff',
    '--no-color',
    '--no-ext-diff',
    '-U0',
    // Named outright, since diff.noprefix or diff.dstPrefix in a gitconfig would change the header parsed below.
    '--src-prefix=a/',
    '--dst-prefix=b/',
    before,
    after,
  ]);
  const files: ExistingFile[] = [];
  let current: { path: string; lines: string[] } | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const named = line.slice(4);
      current = named.startsWith('b/')
        ? { path: join(root, named.slice(2)), lines: [] }
        : null;
      if (current !== null) files.push(current);
      continue;
    }
    if (current !== null && line.startsWith('+')) current.lines.push(line.slice(1));
  }
  return files;
}

function putRight(broken: readonly BrokenCheck[], fingerprint: CodeFingerprint): string {
  const said = broken.map((each) => {
    const check = fingerprint.checks.find((one) => one.name === each.name);
    const instead = check?.instead === undefined ? '' : ` Instead: ${check.instead}.`;
    return `- ${each.name}: ${check?.reason ?? 'a fingerprint check'}. ${each.lines} line(s), first in ${each.first}.${instead}`;
  });
  return [
    "Memnox: that command added lines this repository's code fingerprint forbids. A shell edit is held to the same checks as an edit, so put these right now, before going on:",
    ...said,
  ].join('\n');
}

function git(
  root: string,
  home: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): string {
  return execFileSync('git', args, {
    cwd: root,
    // The real git: the one on PATH is the interceptor, which would rule on this again.
    env: { ...ownProcessEnv(home), ...env },
    encoding: 'utf8',
    maxBuffer: MOST_DIFF_BYTES,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function keptFor(home: string): JsonRecordDir<KeptTree> {
  return new JsonRecordDir(join(home, MEMNOX_HOME, KEPT_DIR));
}

/**
 * The tree kept for this call, by its id first and then by its session, since Cursor rules on
 * a command where it sends no id and reports its return where it sends one.
 */
async function keptTree(
  kept: JsonRecordDir<KeptTree>,
  payload: unknown,
  sessionId: string,
): Promise<{ id: string; before: KeptTree } | null> {
  const keys = [callKey(payload, sessionId), callKey({}, sessionId)];
  for (const id of keys) {
    if (id === null) continue;
    const before = await kept.read(id);
    if (before !== null) return { id, before };
  }
  return null;
}

/**
 * What pairs a command with its return: the host's id for the call where it sends one, else
 * the session, since Gemini and Windsurf send none and run one command at a time.
 */
function callKey(payload: unknown, sessionId: string): string | null {
  const id = fieldsOf(payload)?.['tool_use_id'];
  if (typeof id === 'string' && id !== '') return safe(id);
  return sessionId === '' ? null : `session-${safe(sessionId)}`;
}

function safe(id: string): string {
  return id.replace(/[^\w.-]/g, '_');
}

/** A report whose host reads nothing after a tool, kept to refuse its next call with. */
const OWED_DIR = 'shell-owed';

export async function oweReport(
  home: string,
  sessionId: string,
  report: string,
): Promise<void> {
  if (sessionId !== '') await owedFor(home).write(safe(sessionId), { report });
}

/** The report this session is owed, taken so it is said once, or null. */
export async function takeOwedReport(
  home: string,
  sessionId: string,
): Promise<string | null> {
  if (sessionId === '') return null;
  const owed = owedFor(home);
  const found = await owed.read(safe(sessionId));
  if (found === null) return null;
  await owed.remove(safe(sessionId));
  return found.report;
}

function owedFor(home: string): JsonRecordDir<{ report: string }> {
  return new JsonRecordDir(join(home, MEMNOX_HOME, OWED_DIR));
}
