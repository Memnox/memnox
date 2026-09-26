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
import { shortDigest } from '../domain/digest';
import { HOUR_MS } from '../domain/time';
import { JsonRecordDir } from '../store/json-records';

/**
 * What somebody asked for, written down before the agent starts, because scope drift
 * compared against anything but a declaration is a classifier with an opinion. An absent
 * task is `undeclared` throughout, never a guess and never a violation.
 */
export const TASK_DIR = 'tasks';

export interface SessionTask {
  id: string;
  sessionId: string;
  /** In the words the person used, so a refusal can quote the ask. */
  statement: string;
  scope: DeclaredScope;
  declaredAt: string;
  /** Roughly what this should take: evidence of surprise, never a ceiling on its own. */
  expectedActions?: number;
  /** `investigate` holds the session to reading: a change outside this machine is refused. */
  intent?: TaskIntent;
}

export const TASK_INTENT = { INVESTIGATE: 'investigate' } as const;

export type TaskIntent = (typeof TASK_INTENT)[keyof typeof TASK_INTENT];

export function taskDirFor(home: string): string {
  return join(home, MEMNOX_HOME, TASK_DIR);
}

/** What a person declares for a session, before it is stamped with an id and a time. */
export interface TaskDeclaration {
  sessionId: string;
  statement: string;
  scope: DeclaredScope;
  expectedActions?: number;
  intent?: TaskIntent;
}

export function taskFor(declaration: TaskDeclaration, now: string): SessionTask {
  const { expectedActions, intent } = declaration;
  return {
    id: `tsk_${Date.parse(now).toString(36)}`,
    sessionId: declaration.sessionId,
    statement: declaration.statement,
    scope: declaration.scope,
    declaredAt: now,
    ...(expectedActions === undefined ? {} : { expectedActions }),
    ...(intent === undefined ? {} : { intent }),
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
  private readonly records: JsonRecordDir<SessionTask>;

  constructor(home: string) {
    this.records = new JsonRecordDir(taskDirFor(home));
  }

  async declare(task: SessionTask): Promise<void> {
    await this.records.write(task.sessionId, task);
  }

  /** Null when nothing was declared for this session, which is the ordinary case. */
  read(sessionId: string): Promise<SessionTask | null> {
    return this.records.read(sessionId);
  }

  async all(): Promise<SessionTask[]> {
    const found = await this.records.all();
    return found.sort((a, b) => a.declaredAt.localeCompare(b.declaredAt));
  }

  async clear(sessionId: string): Promise<void> {
    await this.records.remove(sessionId);
  }
}

/**
 * The five dimensions of a request, read off what the caller reported and taken
 * verbatim, because deriving a service from a path would be a guess.
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
 * How this request sat against what was asked for. `undeclared` when no task was, which
 * is not a finding: most sessions declare none and calling that drift would drown it.
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

/** How long a task declared for a repository stands, since a forgotten one would narrow for ever. */
export const REPOSITORY_TASK_HOURS = 12;

const REPOSITORY_TASK_DIR = 'repo-tasks';

export interface RepositoryTask extends SessionTask {
  root: string;
  until: string;
}

/**
 * A task somebody declared for a repository rather than for one session, which is how a
 * session only the hooks see gets one: nobody knows its id, everybody knows the repository.
 */
export class RepositoryTasks {
  private readonly records: JsonRecordDir<RepositoryTask>;

  constructor(home: string) {
    this.records = new JsonRecordDir(join(home, MEMNOX_HOME, REPOSITORY_TASK_DIR));
  }

  async declare(
    root: string,
    declaration: Omit<TaskDeclaration, 'sessionId'>,
    moment: { now: string; hours?: number },
  ): Promise<RepositoryTask> {
    const hours = moment.hours ?? REPOSITORY_TASK_HOURS;
    const task: RepositoryTask = {
      ...taskFor({ ...declaration, sessionId: `repo:${root}` }, moment.now),
      root,
      until: new Date(Date.parse(moment.now) + hours * HOUR_MS).toISOString(),
    };
    await this.records.write(idFor(root), task);
    return task;
  }

  /** The task standing for this repository, or null where none is or it ran out. */
  async inForce(root: string | null, now: string): Promise<RepositoryTask | null> {
    if (root === null) return null;
    const task = await this.records.read(idFor(root));
    return task !== null && task.until > now ? task : null;
  }

  async clear(root: string): Promise<void> {
    await this.records.remove(idFor(root));
  }
}

function idFor(root: string): string {
  return shortDigest(root);
}
