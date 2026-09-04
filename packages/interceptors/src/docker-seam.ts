import type { ActionRequest } from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';
import type { HookAuthorizer, HookVerdict } from './hook-authorizer';

/**
 * An agent that can reach the socket can reach the whole host, which is why discovery
 * ranks it critical. These are the calls worth naming; everything else is `docker.request`.
 */
const ROUTES: readonly { method: string; pattern: RegExp; action: string }[] = [
  {
    method: 'POST',
    pattern: /^\/(?:v[\d.]+\/)?containers\/create/,
    action: 'container.create',
  },
  {
    method: 'POST',
    pattern: /^\/(?:v[\d.]+\/)?containers\/[^/]+\/exec/,
    action: 'container.exec',
  },
  {
    method: 'POST',
    pattern: /^\/(?:v[\d.]+\/)?exec\/[^/]+\/start/,
    action: 'container.exec',
  },
  {
    method: 'POST',
    pattern: /^\/(?:v[\d.]+\/)?containers\/[^/]+\/start/,
    action: 'container.start',
  },
  {
    method: 'POST',
    pattern: /^\/(?:v[\d.]+\/)?containers\/[^/]+\/kill/,
    action: 'container.kill',
  },
  {
    method: 'DELETE',
    pattern: /^\/(?:v[\d.]+\/)?containers\//,
    action: 'container.delete',
  },
  { method: 'DELETE', pattern: /^\/(?:v[\d.]+\/)?images\//, action: 'image.delete' },
  { method: 'DELETE', pattern: /^\/(?:v[\d.]+\/)?volumes\//, action: 'volume.delete' },
  {
    method: 'POST',
    pattern: /^\/(?:v[\d.]+\/)?volumes\/create/,
    action: 'volume.create',
  },
  { method: 'POST', pattern: /^\/(?:v[\d.]+\/)?build/, action: 'image.build' },
];

/** Reads are the ordinary majority; naming them separately keeps rules writable. */
export const DOCKER_READ_ACTION = 'docker.read';
export const DOCKER_DEFAULT_ACTION = 'docker.request';

export const DOCKER_ACTIONS: readonly string[] = [
  ...new Set(ROUTES.map((route) => route.action)),
  DOCKER_READ_ACTION,
  DOCKER_DEFAULT_ACTION,
];

/** Declared, and shown wherever coverage is reported. */
export const DOCKER_BLIND_SPOTS: readonly string[] = [
  'anything a container does once it is allowed to start',
  'a client that talks to the real socket instead of this one',
  'the contents of a build context or an exec stream',
];

export interface DockerOutcome {
  allowed: boolean;
  action: string;
  message?: string;
}

export interface DockerAttempt {
  method: string;
  path: string;
}

export interface DockerSeamDeps {
  authorizer: HookAuthorizer;
  sessionId?: string;
}

/** The action a Docker call amounts to, read off the method and the path. */
export function dockerActionFor(attempt: DockerAttempt): string {
  const method = attempt.method.toUpperCase();
  const matched = ROUTES.find(
    (route) => route.method === method && route.pattern.test(attempt.path),
  );
  if (matched !== undefined) return matched.action;
  return method === 'GET' || method === 'HEAD'
    ? DOCKER_READ_ACTION
    : DOCKER_DEFAULT_ACTION;
}

/**
 * Sits on its own socket in front of the real one, so a call the agent makes is a call
 * somebody ruled on. It forwards unchanged or refuses; it never edits a request.
 */
export class DockerSeam {
  constructor(private readonly deps: DockerSeamDeps) {}

  async gate(attempt: DockerAttempt): Promise<DockerOutcome> {
    const action = dockerActionFor(attempt);

    const request: ActionRequest = {
      action,
      target: attempt.path,
      arguments: { method: attempt.method, path: attempt.path },
      ...(this.deps.sessionId === undefined ? {} : { sessionId: this.deps.sessionId }),
    };

    const verdict = await this.deps.authorizer.authorize(request);
    if (verdict.effect === DECISION_EFFECT.ALLOW) return { allowed: true, action };
    return { allowed: false, action, message: describe(verdict) };
  }
}

function describe(verdict: HookVerdict): string {
  const parts = [verdict.reason];
  if (verdict.alternative !== undefined) {
    parts.push(`Instead: ${verdict.alternative.action} — ${verdict.alternative.note}`);
  }
  if (verdict.approvalId !== undefined) {
    parts.push(`Ask a person: memnox approvals resolve ${verdict.approvalId} --by <you>`);
  }
  if (verdict.decisionId !== undefined) {
    parts.push(`Why: memnox why ${verdict.decisionId}`);
  }
  return parts.join(' ');
}
