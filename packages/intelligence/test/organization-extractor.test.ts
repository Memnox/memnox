import { describe, expect, it } from 'vitest';
import type { LlmProvider } from '../src/llm-provider';
import { OrganizationExtractor, type SourceMessage } from '../src/organization-extractor';

const MESSAGES: SourceMessage[] = [
  {
    id: 'msg-1',
    author: 'alice',
    occurredAt: '2026-05-01T10:00:00.000Z',
    text: 'Refunds above 1,000 need my sign-off from now on.',
    sourceRef: 'https://slack.com/archives/C1/p1',
  },
];

const stub = (answer: string): LlmProvider => ({
  name: 'stub',
  complete: async () => answer,
});

const extract = (
  answer: string,
  messages: SourceMessage[] = MESSAGES,
): Promise<Awaited<ReturnType<OrganizationExtractor['extract']>>> => {
  let counter = 0;
  return new OrganizationExtractor(stub(answer)).extract({
    workspaceId: 'acme',
    messages,
    newId: () => `stated-${++counter}`,
    detectedAt: '2026-05-02T00:00:00.000Z',
  });
};

const ONE_POLICY = JSON.stringify([
  {
    kind: 'policy',
    statement: 'Refunds above 1,000 need Alice’s sign-off.',
    subject: 'payment.refund',
    confidence: 0.9,
    evidence: ['msg-1'],
  },
]);

describe('OrganizationExtractor', () => {
  it('produces candidates and nothing else — a model cannot write a binding statement', async () => {
    const [stated] = await extract(ONE_POLICY);

    expect(stated?.status).toBe('candidate');
    expect(stated?.provenance).toBe('observed');
    expect(stated?.verifiedBy).toBeUndefined();
  });

  it('carries the permalink of the message it read', async () => {
    const [stated] = await extract(ONE_POLICY);

    expect(stated?.sourceRef).toBe('https://slack.com/archives/C1/p1');
    expect(stated?.evidence).toEqual(['msg-1']);
  });

  it('scopes what it writes to the workspace it was asked about', async () => {
    const [stated] = await extract(ONE_POLICY);

    expect(stated?.workspaceId).toBe('acme');
  });

  it('reads an authority with its ceiling', async () => {
    const [stated] = await extract(
      JSON.stringify([
        {
          kind: 'authority',
          statement: 'Alice approves refunds up to 50,000.',
          subject: 'payment.refund',
          principal: 'alice',
          capability: 'payment.refund',
          limit: 50_000,
          confidence: 0.8,
        },
      ]),
    );

    expect(stated?.principal).toBe('alice');
    expect(stated?.limit).toBe(50_000);
  });

  it('drops a statement with no subject rather than inventing one', async () => {
    const extracted = await extract(
      JSON.stringify([{ kind: 'policy', statement: 'Something.', confidence: 0.9 }]),
    );

    expect(extracted).toEqual([]);
  });

  it('drops a kind the organization has no word for', async () => {
    const extracted = await extract(
      JSON.stringify([
        { kind: 'vibe', statement: 'Something.', subject: 'x', confidence: 0.9 },
      ]),
    );

    expect(extracted).toEqual([]);
  });

  it('drops what the reader was not sure about', async () => {
    const extracted = await extract(
      JSON.stringify([
        { kind: 'policy', statement: 'Maybe.', subject: 'x', confidence: 0.1 },
      ]),
    );

    expect(extracted).toEqual([]);
  });

  it('reads JSON a model wrapped in prose', async () => {
    const extracted = await extract(
      `Here is what I found:\n${ONE_POLICY}\nHope that helps.`,
    );

    expect(extracted).toHaveLength(1);
  });

  it('treats a malformed answer as an empty run, never a partial statement', async () => {
    expect(await extract('[{"kind": "policy", "statement":')).toEqual([]);
    expect(await extract('I could not find anything.')).toEqual([]);
  });

  it('never calls the model when there is nothing to read', async () => {
    let called = false;
    const provider: LlmProvider = {
      name: 'stub',
      complete: async () => {
        called = true;
        return ONE_POLICY;
      },
    };

    const extracted = await new OrganizationExtractor(provider).extract({
      workspaceId: 'acme',
      messages: [],
      newId: () => 'stated-1',
      detectedAt: '2026-05-02T00:00:00.000Z',
    });

    expect(extracted).toEqual([]);
    expect(called).toBe(false);
  });

  it('bounds one run, so a noisy channel cannot flood the review queue', async () => {
    const many = Array.from({ length: 50 }, (_unused, index) => ({
      kind: 'decision',
      statement: `Decision ${index}.`,
      subject: `topic-${index}`,
      confidence: 0.9,
    }));

    expect(await extract(JSON.stringify(many))).toHaveLength(25);
  });
});
