/** Declared scope: what the person asked for, as data the client already holds. */
export interface DeclaredScope {
  paths?: readonly string[];
  repositories?: readonly string[];
  services?: readonly string[];
  environments?: readonly string[];
  resourceKinds?: readonly string[];
}

export const TASK_DECLARED_BY = {
  HUMAN: 'human',
  AGENT: 'agent',
  WORKFLOW: 'workflow',
} as const;

export type TaskDeclaredBy = (typeof TASK_DECLARED_BY)[keyof typeof TASK_DECLARED_BY];

/** Intent as data. Declared by the client, never inferred on the decision path. */
export interface Task {
  id: string;
  sessionId: string;
  subjectId: string;
  /** What the person actually asked for: "fix the failing auth tests". */
  statement: string;
  declaredScope: DeclaredScope;
  declaredBy: TaskDeclaredBy;
  startedAt: string;
  endedAt?: string;
}

export interface TaskRef {
  id: string;
  statement: string;
}

/** What a request touches, compared field by field against the declared scope. */
export interface ScopeSubject {
  path?: string;
  repository?: string;
  service?: string;
  environment?: string;
  resourceKind?: string;
}

export const SCOPE_MATCH = {
  IN_SCOPE: 'in_scope',
  OUT_OF_SCOPE: 'out_of_scope',
  /** The task declared nothing about this dimension, so there is nothing to compare. */
  UNDECLARED: 'undeclared',
} as const;

export type ScopeMatch = (typeof SCOPE_MATCH)[keyof typeof SCOPE_MATCH];

export interface ScopeComparison {
  match: ScopeMatch;
  /** The dimension that fell outside, so the refusal can name it. */
  dimension?: keyof ScopeSubject;
  declared?: readonly string[];
  actual?: string;
}

const DIMENSIONS: readonly (readonly [keyof ScopeSubject, keyof DeclaredScope])[] = [
  ['path', 'paths'],
  ['repository', 'repositories'],
  ['service', 'services'],
  ['environment', 'environments'],
  ['resourceKind', 'resourceKinds'],
];

/**
 * Scope is compared, not judged. No model is consulted and none ever will be here: an
 * undeclared dimension is undeclared, never a guess, and the ambiguous middle escalates
 * because a rule said so rather than because a classifier had an opinion.
 */
export function compareDeclaredScope(
  scope: DeclaredScope,
  subject: ScopeSubject,
  matches: (patterns: readonly string[], value: string) => boolean,
): ScopeComparison {
  let sawDeclaration = false;
  for (const [subjectKey, scopeKey] of DIMENSIONS) {
    const declared = scope[scopeKey];
    const actual = subject[subjectKey];
    if (declared === undefined || declared.length === 0) continue;
    if (actual === undefined) continue;
    sawDeclaration = true;
    if (matches(declared, actual)) continue;
    return {
      match: SCOPE_MATCH.OUT_OF_SCOPE,
      dimension: subjectKey,
      declared,
      actual,
    };
  }
  return { match: sawDeclaration ? SCOPE_MATCH.IN_SCOPE : SCOPE_MATCH.UNDECLARED };
}

export function taskRefOf(task: Task): TaskRef {
  return { id: task.id, statement: task.statement };
}

export interface TaskStore {
  save(task: Task): Promise<void>;
  findBySession(sessionId: string): Promise<Task | null>;
  findById(id: string): Promise<Task | null>;
}
