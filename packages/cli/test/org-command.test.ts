import { describe, expect, it } from 'vitest';
import type { LlmProvider } from '@memnox/intelligence';
import type { MessageSource } from '@memnox/intelligence';
import {
  buildMessageSource,
  registerOrgCommand,
  type MessageSourceFactory,
} from '../src/commands/org.command';
import { FakeRuntime, runCommand } from './cli-harness';

const CANDIDATES_PATH = '/v1/organization/candidates';
const STATEMENTS_PATH = '/v1/organization/statements';
const AUTHORITY_PATH = '/v1/organization/authority';

const ONE_POLICY = JSON.stringify([
  {
    kind: 'policy',
    statement: 'Refunds above 1,000 need the Finance Manager.',
    subject: 'payment.refund',
    confidence: 0.9,
    evidence: ['msg-1'],
  },
]);

const fakeLlm = (answer: string): LlmProvider => ({
  name: 'fake',
  complete: async () => answer,
});

const fakeSource =
  (texts: string[]): MessageSourceFactory =>
  () =>
    ({
      name: 'fake-slack',
      read: async () =>
        texts.map((text, index) => ({
          id: `msg-${index + 1}`,
          author: 'alice',
          occurredAt: '2026-05-01T10:00:00.000Z',
          text,
          sourceRef: `https://slack.com/archives/C1/p${index + 1}`,
        })),
    }) satisfies MessageSource;

/** Everything the command told the operator; these commands report on stderr. */
const said = (out: { notes: string[]; lines: string[] }): string =>
  [...out.notes, ...out.lines].join('\n');

const run = (
  args: string[],
  runtime: FakeRuntime,
  llm = fakeLlm(ONE_POLICY),
  source = fakeSource(['Refunds above 1,000 need the Finance Manager from now on.']),
): ReturnType<typeof runCommand> =>
  runCommand(
    (program, context) => registerOrgCommand(program, context, () => llm, source),
    args,
    runtime,
  );

describe('memnox org import', () => {
  it('files what it read as candidates, and says they enforce nothing yet', async () => {
    const runtime = new FakeRuntime().on('POST', CANDIDATES_PATH, { stored: 1 });

    const { out } = await run(
      ['org', 'import', '--channel', 'C0123', '--source-token', 'xoxb'],
      runtime,
    );

    const filed = runtime.requests.find((request) => request.path === CANDIDATES_PATH);
    const body = filed?.body as { candidates: Array<{ status: string }> };
    expect(body.candidates[0]?.status).toBe('candidate');
    expect(said(out)).toContain('until you run "memnox org verify');
  });

  it('sends nothing on a dry run', async () => {
    const runtime = new FakeRuntime();

    const { out } = await run(
      ['org', 'import', '--channel', 'C0123', '--source-token', 'xoxb', '--dry-run'],
      runtime,
    );

    expect(runtime.requests).toEqual([]);
    expect(said(out)).toContain('Dry run');
  });

  it('stops before the model when there is no source token', async () => {
    const runtime = new FakeRuntime();
    let asked = false;
    const llm: LlmProvider = {
      name: 'fake',
      complete: async () => {
        asked = true;
        return ONE_POLICY;
      },
    };

    const { out } = await run(['org', 'import', '--channel', 'C0123'], runtime, llm);

    expect(asked).toBe(false);
    expect(said(out)).toContain('No source token');
  });

  it('stops before the model when the channel has nothing to read', async () => {
    const runtime = new FakeRuntime();
    let asked = false;
    const llm: LlmProvider = {
      name: 'fake',
      complete: async () => {
        asked = true;
        return ONE_POLICY;
      },
    };

    await run(
      ['org', 'import', '--channel', 'C0123', '--source-token', 'xoxb'],
      runtime,
      llm,
      fakeSource([]),
    );

    expect(asked).toBe(false);
    expect(runtime.requests).toEqual([]);
  });

  it('files nothing when the model found nothing', async () => {
    const runtime = new FakeRuntime();

    const { out } = await run(
      ['org', 'import', '--channel', 'C0123', '--source-token', 'xoxb'],
      runtime,
      fakeLlm('[]'),
    );

    expect(runtime.requests).toEqual([]);
    expect(said(out)).toContain('found 0 candidate statement(s)');
  });
});

describe('memnox org state and delegate', () => {
  it('records a statement a person entered', async () => {
    const runtime = new FakeRuntime().on('POST', STATEMENTS_PATH, {
      id: 'stated-1',
      statement: 'Deploys freeze in December.',
    });

    await run(
      [
        'org',
        'state',
        '--kind',
        'policy',
        '--statement',
        'Deploys freeze in December.',
        '--subject',
        'deploy.service',
        '--clearance',
        'cfo@acme.com, platform@acme.com',
      ],
      runtime,
    );

    const body = runtime.requests[0]?.body as { clearance: string[] };
    expect(body.clearance).toEqual(['cfo@acme.com', 'platform@acme.com']);
  });

  it('records a delegation with its ceiling', async () => {
    const runtime = new FakeRuntime().on('POST', AUTHORITY_PATH, {
      id: 'grant-1',
      principal: 'alice@acme.com',
      actions: ['expense.approve'],
      limit: 5000,
    });

    const { out } = await run(
      [
        'org',
        'delegate',
        '--principal',
        'alice@acme.com',
        '--actions',
        'expense.approve',
        '--limit',
        '5000',
      ],
      runtime,
    );

    const body = runtime.requests[0]?.body as { limit: number; actions: string[] };
    expect(body.limit).toBe(5000);
    expect(body.actions).toEqual(['expense.approve']);
    expect(said(out)).toContain('up to 5000');
  });

  it('confirms a candidate', async () => {
    const runtime = new FakeRuntime().on('POST', `${STATEMENTS_PATH}/stated-1/verify`, {
      id: 'stated-1',
      statement: 'Deploys freeze in December.',
    });

    const { out } = await run(['org', 'verify', 'stated-1', '--by', 'alice'], runtime);

    expect(runtime.requests[0]?.body).toEqual({ by: 'alice' });
    expect(said(out)).toContain('Verified: Deploys freeze in December.');
  });
});

describe('buildMessageSource', () => {
  it('refuses a source nobody has written a connector for', () => {
    expect(() => buildMessageSource('carrier-pigeon', 'token')).toThrow(/unknown source/);
  });

  it('builds the Slack connector', () => {
    expect(buildMessageSource('slack', 'xoxb').name).toBe('slack');
  });
});
