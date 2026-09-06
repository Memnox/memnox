import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MEMNOX_HOME } from '../config/config';
import {
  compareDeclaredScope,
  SCOPE_MATCH,
  type DeclaredScope,
  type ScopeComparison,
  type ScopeSubject,
} from '../domain/task';
import type { ActionRequest } from '../domain/action-event';

/**
 * What somebody actually asked for, written down before the agent starts.
 *
 * Everything that can say "this went somewhere it was not asked to go" needs one of
 * these, and none of it can be inferred: scope drift compares against a declaration or
 * it is a classifier with an opinion, and action explosion needs a number a person
 * chose rather than one this file invented. An absent task is `undeclared` throughout —
 * never a guess, and never treated as a violation.
 */
export const TASK_DIR = 'tasks';

export interface SessionTask {
  id: string;
  sessionId: string;
  /** In the words the person used, so a refusal can quote the ask. */
  statement: string;
  scope: DeclaredScope;
  declaredAt: string;
  /**
   * Roughly what this should take. Compared against, never enforced on its own: an
   * estimate somebody typed is evidence of surprise, not a ceiling.
   */
  expectedActions?: number;
}

export function taskDirFor(home: string): string {
  return join(home, MEMNOX_HOME, TASK_DIR);
}

export function taskFor(
  sessionId: string,
  statement: string,
  scope: DeclaredScope,
  now: string,
  expectedActions?: number,
): SessionTask {
  return {
    id: `tsk_${Date.parse(now).toString(36)}`,
    sessionId,
    statement,
    scope,
    declaredAt: now,
    ...(expectedActions === undefined ? {} : { expectedActions }),
  };
}

/** Nothing declared at all. Written so a caller can say so rather than test for empty. */
export function isEmptyScope(scope: DeclaredScope): boolean {
  return [
    scope.paths,
    scope.repositories,
    scope.services,
    scope.environments,
    scope.resourceKinds,
  ].every((each) => each === undefined || each.length === 0);
}

export class SessionTasks {
  constructor(private readonly home: string) {}

  async declare(task: SessionTask): Promise<void> {
    await mkdir(taskDirFor(this.home), { recursive: true, mode: 0o700 });
    await writeFile(this.pathFor(task.sessionId), `${JSON.stringify(task, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  async read(sessionId: string): Promise<SessionTask | null> {
    try {
      return JSON.parse(await readFile(this.pathFor(sessionId), 'utf8')) as SessionTask;
    } catch {
      // Nothing was declared for this session, which is the ordinary case.
      return null;
    }
  }

  async all(): Promise<SessionTask[]> {
    let names: string[];
    try {
      names = await readdir(taskDirFor(this.home));
    } catch {
      return [];
    }
    const found: SessionTask[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const task = await this.read(name.slice(0, -5));
      if (task !== null) found.push(task);
    }
    return found.sort((a, b) => a.declaredAt.localeCompare(b.declaredAt));
  }

  async clear(sessionId: string): Promise<void> {
    await rm(this.pathFor(sessionId), { force: true });
  }

  private pathFor(sessionId: string): string {
    return join(taskDirFor(this.home), `${sessionId}.json`);
  }
}

/**
 * The five dimensions of a request, read off what the caller already reported.
 *
 * A path is the working directory or the target, whichever is there — a rule about
 * `src/checkout` has to fire on `cat src/checkout/x.ts` and on an agent running inside
 * it. The rest are taken verbatim: nothing here derives a service from a path, because
 * that mapping is a guess and a wrong one produces a refusal nobody can argue with.
 */
export function subjectOf(request: ActionRequest): ScopeSubject {
  const namespace = request.action.split('.')[0];
  return {
    ...(request.target === undefined ? {} : { path: request.target }),
    ...(request.workingDirectory === undefined
      ? {}
      : { repository: request.workingDirectory }),
    ...(request.projectId === undefined ? {} : { service: request.projectId }),
    ...(request.environment === undefined ? {} : { environment: request.environment }),
    ...(namespace === undefined ? {} : { resourceKind: namespace }),
  };
}

/**
 * How this request sat against what was asked for. `undeclared` when no task was
 * declared, which is not a finding: most sessions never declare one, and reporting
 * every one of them as drift would make the signal worthless within a day.
 */
export function scopeOf(
  task: SessionTask | null,
  request: ActionRequest,
  matches: (patterns: readonly string[], value: string) => boolean,
): ScopeComparison {
  if (task === null) return { match: SCOPE_MATCH.UNDECLARED };
  return compareDeclaredScope(task.scope, subjectOf(request), matches);
}

/** The line a refusal or a report uses. Names the dimension, never merely "out of scope". */
export function describeDrift(task: SessionTask, drift: ScopeComparison): string {
  if (drift.match !== SCOPE_MATCH.OUT_OF_SCOPE) return '';
  return `"${task.statement}" declared ${drift.dimension} ${(drift.declared ?? []).join(', ')}; this touches ${drift.actual ?? 'something else'}`;
}
