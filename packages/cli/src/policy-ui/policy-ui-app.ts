import { stringify } from 'yaml';
import { DECISION_EFFECT, EFFECT_PRECEDENCE, type DecisionEffect } from '@memnox/core';
import {
  findPolicyPack,
  mergePolicies,
  DEFAULT_POLICY_MODE,
  POLICY_DOCUMENT_VERSION,
  POLICY_MODE,
  POLICY_PACKS,
  PolicyValidationError,
  validatePolicyDocument,
  versionPolicySet,
  type Policy,
  type PolicyComparison,
  type PolicyDocument,
} from '@memnox/policy-engine';
import { statesMatch } from '../browser-login';
import { renderPolicyUiPage } from './policy-ui-page';
import {
  ALLOWED_UI_HOSTNAMES,
  CONTENT_TYPE,
  UI_PATH,
  UI_SESSION_HEADER,
} from './policy-ui.constants';

export interface PolicyUiRequest {
  method: string;
  /** Path and query as the browser sent them, e.g. "/api/save". */
  url: string;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface PolicyUiResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type PolicyUiHandler = (request: PolicyUiRequest) => Promise<PolicyUiResponse>;

export type SimulationReport =
  ({ available: true } & PolicyComparison) | { available: false; reason: string };

interface PolicyUiDeps {
  filePath: string;
  sessionToken: string;
  read(): Promise<PolicyDocument>;
  write(document: PolicyDocument): Promise<void>;
  simulate(candidate: readonly Policy[]): Promise<SimulationReport>;
  /** Server-side failures the browser tab would otherwise swallow. */
  onError(message: string): void;
}

const STATUS = {
  OK: 200,
  BAD_REQUEST: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  SERVER_ERROR: 500,
} as const;

/** Escalating order, so the effect picker reads allow → block left to right. */
const EFFECTS: readonly DecisionEffect[] = Object.values(DECISION_EFFECT).sort(
  (left, right) => EFFECT_PRECEDENCE[left] - EFFECT_PRECEDENCE[right],
);

/** Only this origin exists: no CORS headers are served, on any route. */
const NO_STORE = { 'cache-control': 'no-store' };

function response(
  status: number,
  contentType: string,
  body: string,
  extra: Record<string, string> = {},
): PolicyUiResponse {
  return {
    status,
    headers: { 'content-type': contentType, ...NO_STORE, ...extra },
    body,
  };
}

const json = (status: number, payload: unknown): PolicyUiResponse =>
  response(status, CONTENT_TYPE.JSON, JSON.stringify(payload));

const text = (status: number, body: string): PolicyUiResponse =>
  response(status, CONTENT_TYPE.TEXT, body);

/** `Host` is what separates a real loopback visit from a rebound hostname. */
function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end > 0 && ALLOWED_UI_HOSTNAMES.includes(host.slice(1, end));
  }
  const [hostname] = host.split(':');
  return hostname !== undefined && ALLOWED_UI_HOSTNAMES.includes(hostname);
}

function authorized(request: PolicyUiRequest, sessionToken: string): boolean {
  const presented = request.headers[UI_SESSION_HEADER];
  return statesMatch(sessionToken, presented === undefined ? null : presented);
}

/** Every payload from the page is a whole document, so one parser covers them all. */
function documentFrom(body: string): PolicyDocument {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new PolicyValidationError(['request body must be an object']);
  }
  const { project, policies } = parsed as { project?: unknown; policies?: unknown };
  return validatePolicyDocument({
    version: POLICY_DOCUMENT_VERSION,
    ...(project === undefined || project === null ? {} : { project }),
    policies,
  });
}

function serialize(document: PolicyDocument): string {
  return stringify({
    version: POLICY_DOCUMENT_VERSION,
    ...(document.project === undefined ? {} : { project: document.project }),
    policies: document.policies,
  });
}

function issuesOf(err: unknown): string[] {
  if (err instanceof PolicyValidationError) return err.issues;
  return [err instanceof Error ? err.message : String(err)];
}

/** Nothing here reads a socket or a file — the ports do that. */
export function createPolicyUiHandler(deps: PolicyUiDeps): PolicyUiHandler {
  const page = renderPolicyUiPage({
    filePath: deps.filePath,
    sessionToken: deps.sessionToken,
    effects: EFFECTS,
    approvalEffect: DECISION_EFFECT.REQUIRE_APPROVAL,
    modes: Object.values(POLICY_MODE),
    defaultMode: DEFAULT_POLICY_MODE,
    packs: POLICY_PACKS.map((pack) => ({
      name: pack.name,
      description: pack.description,
      policyCount: pack.policies.length,
    })),
  });

  const routes: Record<string, (request: PolicyUiRequest) => Promise<PolicyUiResponse>> =
    {
      [UI_PATH.DOCUMENT]: async () => {
        const document = await deps.read();
        return json(STATUS.OK, { filePath: deps.filePath, document });
      },

      [UI_PATH.VALIDATE]: async (request) => {
        try {
          const document = documentFrom(request.body);
          return json(STATUS.OK, {
            valid: true,
            issues: [],
            yaml: serialize(document),
            ...versionPolicySet(document.policies),
          });
        } catch (err) {
          // Invalid is the expected state mid-edit, not a failed request.
          return json(STATUS.OK, { valid: false, issues: issuesOf(err) });
        }
      },

      [UI_PATH.SAVE]: async (request) => {
        let document: PolicyDocument;
        try {
          document = documentFrom(request.body);
        } catch (err) {
          return json(STATUS.BAD_REQUEST, { saved: false, issues: issuesOf(err) });
        }
        try {
          await deps.write(document);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          deps.onError(`could not write ${deps.filePath}: ${message}`);
          return json(STATUS.SERVER_ERROR, { saved: false, issues: [message] });
        }
        return json(STATUS.OK, {
          saved: true,
          policies: document.policies,
          yaml: serialize(document),
          ...versionPolicySet(document.policies),
        });
      },

      [UI_PATH.PACK]: async (request) => {
        let requested: { pack?: unknown };
        try {
          requested = JSON.parse(request.body) as { pack?: unknown };
        } catch (err) {
          return json(STATUS.BAD_REQUEST, { error: issuesOf(err)[0] });
        }
        const pack =
          typeof requested.pack === 'string' ? findPolicyPack(requested.pack) : null;
        if (pack === null)
          return json(STATUS.BAD_REQUEST, { error: 'unknown policy pack' });

        let existing: readonly Policy[];
        try {
          existing = documentFrom(request.body).policies;
        } catch (err) {
          return json(STATUS.BAD_REQUEST, { error: issuesOf(err)[0] });
        }
        return json(STATUS.OK, mergePolicies(existing, pack.policies));
      },

      [UI_PATH.SIMULATE]: async (request) => {
        let document: PolicyDocument;
        try {
          document = documentFrom(request.body);
        } catch (err) {
          return json(STATUS.OK, { available: false, reason: issuesOf(err)[0] });
        }
        try {
          return json(STATUS.OK, await deps.simulate(document.policies));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          deps.onError(`simulation failed: ${message}`);
          return json(STATUS.OK, { available: false, reason: message });
        }
      },
    };

  return async (request) => {
    if (!isLoopbackHost(request.headers['host'])) {
      return text(STATUS.FORBIDDEN, 'the policy editor answers loopback requests only');
    }

    const path = new URL(request.url, `http://${ALLOWED_UI_HOSTNAMES[0]}`).pathname;
    if (path === UI_PATH.PAGE) {
      if (request.method !== 'GET') {
        return text(STATUS.METHOD_NOT_ALLOWED, 'GET only');
      }
      return response(STATUS.OK, CONTENT_TYPE.HTML, page);
    }

    const route = routes[path];
    if (route === undefined) return json(STATUS.NOT_FOUND, { error: 'no such route' });
    if (!authorized(request, deps.sessionToken)) {
      return json(STATUS.FORBIDDEN, { error: 'missing or stale editor session token' });
    }
    // Reading the document is the one route the page fetches without a body.
    if (request.method !== 'POST' && path !== UI_PATH.DOCUMENT) {
      return json(STATUS.METHOD_NOT_ALLOWED, { error: 'POST only' });
    }

    try {
      return await route(request);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.onError(`${path} failed: ${message}`);
      return json(STATUS.SERVER_ERROR, { error: message });
    }
  };
}
