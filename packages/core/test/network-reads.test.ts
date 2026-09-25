import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CHANGING_HTTP_METHODS,
  HTTP_METHOD,
  HTTP_METHOD_ARGUMENT,
} from '../src/constants/action.constants';
import { DECISION_EFFECT } from '../src/constants/decision.constants';
import { classifyBinary, requestMethodOf } from '../src/intercept/binary-class';
import { loadPoliciesFromFile } from '../src/gate/policy-file';
import {
  DOMAIN_CHOICES,
  POLICY_DOMAIN,
  policiesFrom,
  recommendedAnswers,
} from '../src/policy/domains';
import { toClaudeCodePermissions } from '../src/policy/native';
import { PolicyEngine } from '../src/policy/policy-engine';
import type { Policy } from '../src/policy/policy';

const CONTEXT = { agentName: 'claude-code' };
const DOCS = 'docs.composio.dev';

/* An agent asked for a person's yes to read a toolkit's documentation, and got refused
   because nobody could be asked. Reading is ordinary work; changing a host is not. */
describe('the method a command line sends', () => {
  it.each([
    [['-s', `https://${DOCS}/toolkits/discordbot`], HTTP_METHOD.GET],
    [['-G', '-d', 'q=discord', `https://${DOCS}/search`], HTTP_METHOD.GET],
    [['-I', `https://${DOCS}`], HTTP_METHOD.HEAD],
    [['-X', 'POST', 'https://api.example.com/x'], 'POST'],
    [['--request', 'delete', 'https://api.example.com/x/1'], 'DELETE'],
    [['-XPUT', 'https://api.example.com/x/1'], 'PUT'],
    [['--method=PATCH', 'https://api.example.com/x/1'], 'PATCH'],
    [['-d', 'a=1', 'https://api.example.com/x'], HTTP_METHOD.POST],
    [['--data=a=1', 'https://api.example.com/x'], HTTP_METHOD.POST],
    [['--json', '{}', 'https://api.example.com/x'], HTTP_METHOD.POST],
    [['--post-data=a=1', 'https://api.example.com/x'], HTTP_METHOD.POST],
  ])('%j is a %s', (args, method) => {
    expect(requestMethodOf(args)).toBe(method);
  });

  it('is carried on the verdict for curl and wget alike', () => {
    expect(classifyBinary('curl', [`https://${DOCS}`])?.method).toBe(HTTP_METHOD.GET);
    expect(classifyBinary('wget', ['--post-data=a', 'https://x.io'])?.method).toBe(
      HTTP_METHOD.POST,
    );
  });
});

describe('the network rule the baseline writes', () => {
  const network = policiesFrom(recommendedAnswers()).find((policy) =>
    policy.name.startsWith(POLICY_DOMAIN.NETWORK),
  ) as Policy;
  const engine = new PolicyEngine([network]);
  const request = (method?: string): ReturnType<PolicyEngine['evaluate']> =>
    engine.evaluate(
      {
        action: 'http.request',
        target: DOCS,
        ...(method === undefined
          ? {}
          : { arguments: { [HTTP_METHOD_ARGUMENT]: method } }),
      },
      CONTEXT,
    );

  it('lets a read through, so documentation never waits on a person', () => {
    expect(request(HTTP_METHOD.GET).effect).toBe(DECISION_EFFECT.ALLOW);
    expect(request(HTTP_METHOD.HEAD).effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('asks about every method that changes something', () => {
    for (const method of CHANGING_HTTP_METHODS) {
      expect(request(method).effect, method).toBe(DECISION_EFFECT.ASK);
    }
  });

  it('says why in words about changes, not about hosts', () => {
    const choice = DOMAIN_CHOICES.find((each) => each.domain === POLICY_DOMAIN.NETWORK);
    expect(choice?.because).toContain('POST');
  });

  it('is never written as a Claude Code permission, which would ask about every fetch', () => {
    const { permissions, untranslated } = toClaudeCodePermissions([network]);
    expect(permissions.ask).not.toContain('WebFetch');
    expect(untranslated.map((each) => each.policy)).toEqual([network.name]);
  });
});

describe('the rule this repository ships', () => {
  it('reads documentation and asks before a POST', async () => {
    const file = fileURLToPath(new URL('../../../memnox.policies.toml', import.meta.url));
    const engine = new PolicyEngine(await loadPoliciesFromFile(file));
    const on = (method: string): string =>
      engine.evaluate(
        {
          action: 'http.request',
          target: DOCS,
          arguments: { [HTTP_METHOD_ARGUMENT]: method },
        },
        CONTEXT,
      ).effect;
    expect(on(HTTP_METHOD.GET)).toBe(DECISION_EFFECT.ALLOW);
    expect(on(HTTP_METHOD.POST)).toBe(DECISION_EFFECT.ASK);
  });
});

/* The same line for MCP tools and CLIs: an agent reads freely and asks before it changes
   somebody else's system. */
describe('MCP tools and CLIs under the baseline', () => {
  const engine = new PolicyEngine(policiesFrom(recommendedAnswers()));
  const on = (action: string, toolClass?: string): string =>
    engine.evaluate(
      { action, ...(toolClass === undefined ? {} : { toolClass }) },
      CONTEXT,
    ).effect;

  it('lets an MCP read through and asks about a write, a message and a delete', () => {
    expect(on('mcp.github.list_issues', 'read')).toBe(DECISION_EFFECT.ALLOW);
    expect(on('mcp.github.create_issue', 'write')).toBe(DECISION_EFFECT.ASK);
    expect(on('mcp.slack.send_message', 'communication')).toBe(DECISION_EFFECT.ASK);
    expect(on('mcp.github.delete_repo', 'destructive')).toBe(DECISION_EFFECT.ASK);
  });

  it('asks about an MCP tool nothing classified, since it might change anything', () => {
    expect(on('mcp.acme.frobnicate', 'unknown')).toBe(DECISION_EFFECT.ASK);
    expect(on('mcp.acme.frobnicate')).toBe(DECISION_EFFECT.ASK);
  });

  it('lets a CLI read through and asks before it changes a remote system', () => {
    expect(on('gh.pr-list', 'read')).toBe(DECISION_EFFECT.ALLOW);
    expect(on('kubectl.get', 'read')).toBe(DECISION_EFFECT.ALLOW);
    expect(on('gh.pr-merge', 'write')).toBe(DECISION_EFFECT.ASK);
    expect(on('vercel.deploy-prod', 'write')).toBe(DECISION_EFFECT.ASK);
    expect(on('kubectl.delete', 'destructive')).toBe(DECISION_EFFECT.ASK);
    expect(on('npm.publish', 'write')).toBe(DECISION_EFFECT.ASK);
  });

  it('leaves local work alone: installs, builds and test runs', () => {
    expect(on('npm.install', 'write')).toBe(DECISION_EFFECT.ALLOW);
    expect(on('docker.build', 'write')).toBe(DECISION_EFFECT.ALLOW);
    expect(on('playwright.test', 'write')).toBe(DECISION_EFFECT.ALLOW);
  });

  it('allows a CLI verb no table knows, and counts it, rather than blocking it', () => {
    expect(on('aws.frobnicate', 'unknown')).toBe(DECISION_EFFECT.ALLOW);
  });

  it('holds the rule this repository ships to the same line', async () => {
    const file = fileURLToPath(new URL('../../../memnox.policies.toml', import.meta.url));
    const shipped = new PolicyEngine(await loadPoliciesFromFile(file));
    const ruled = (action: string, toolClass: string): string =>
      shipped.evaluate({ action, toolClass }, CONTEXT).effect;
    expect(ruled('mcp.github.list_issues', 'read')).toBe(DECISION_EFFECT.ALLOW);
    expect(ruled('mcp.github.create_issue', 'write')).toBe(DECISION_EFFECT.ASK);
    expect(ruled('gh.pr-view', 'read')).toBe(DECISION_EFFECT.ALLOW);
    expect(ruled('gh.pr-merge', 'write')).toBe(DECISION_EFFECT.ASK);
  });
});
