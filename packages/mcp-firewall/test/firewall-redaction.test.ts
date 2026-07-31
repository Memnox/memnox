import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import { LocalGate, SECRET_RESPONSE } from '@memnox/local-gate';
import {
  FirewallSession,
  LocalGateAuthorizer,
  ToolFilter,
  type CallAuthorizer,
  type CallVerdict,
  type FirewallChannel,
  type JsonRpcMessage,
  type ToolCall,
} from '../src/index';

/** Secrets are assembled at runtime so no test file ever holds one literally. */
const awsKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');

class RecordingChannel implements FirewallChannel {
  readonly server: string[] = [];
  readonly client: string[] = [];

  toServer(payload: string): boolean {
    this.server.push(payload);
    return true;
  }

  toClient(payload: string): void {
    this.client.push(payload);
  }

  forwarded(): JsonRpcMessage {
    return JSON.parse(this.server[this.server.length - 1] ?? '{}') as JsonRpcMessage;
  }

  returned(): JsonRpcMessage {
    return JSON.parse(this.client[this.client.length - 1] ?? '{}') as JsonRpcMessage;
  }
}

class StubAuthorizer implements CallAuthorizer {
  readonly calls: ToolCall[] = [];

  constructor(private readonly verdict: CallVerdict) {}

  async authorize(call: ToolCall): Promise<CallVerdict> {
    this.calls.push(call);
    return this.verdict;
  }
}

function session(authorizer: CallAuthorizer): {
  session: FirewallSession;
  channel: RecordingChannel;
  logs: string[];
} {
  const channel = new RecordingChannel();
  const logs: string[] = [];
  return {
    session: new FirewallSession({
      filter: new ToolFilter(),
      authorizer,
      channel,
      log: (message) => logs.push(message),
    }),
    channel,
    logs,
  };
}

const toolCall = (args: Record<string, unknown>): string =>
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'create_issue', arguments: args },
  });

describe('FirewallSession — arguments reach the authorizer', () => {
  it('hands the call its arguments, which is what argument rules match on', async () => {
    const authorizer = new StubAuthorizer({
      effect: DECISION_EFFECT.ALLOW,
      reason: 'fine',
    });
    const { session: subject } = session(authorizer);

    await subject.fromClient(toolCall({ title: 'bug', count: 3 }));

    expect(authorizer.calls[0]).toEqual({
      name: 'create_issue',
      arguments: { title: 'bug', count: '3' },
    });
  });
});

describe('FirewallSession — redact', () => {
  it('forwards the masked arguments and keeps the call going', async () => {
    const { session: subject, channel } = session(
      new StubAuthorizer({
        effect: DECISION_EFFECT.REDACT,
        reason: 'credential masked',
        redactedArguments: { body: 'key is redacted-by-memnox' },
      }),
    );

    await subject.fromClient(toolCall({ body: `key is ${awsKey}`, title: 'infra' }));

    const forwarded = channel.forwarded();
    expect(forwarded.params?.['arguments']).toEqual({
      body: 'key is redacted-by-memnox',
      title: 'infra',
    });
    expect(channel.client).toHaveLength(0);
  });

  it('blocks when the masked value cannot be put back as it came', async () => {
    const { session: subject, channel } = session(
      new StubAuthorizer({
        effect: DECISION_EFFECT.REDACT,
        reason: 'credential masked',
        // The original argument is structured, so a masked string cannot replace it.
        redactedArguments: { payload: 'redacted-by-memnox' },
      }),
    );

    await subject.fromClient(toolCall({ payload: { token: awsKey } }));

    expect(channel.server).toHaveLength(0);
    expect(JSON.stringify(channel.returned())).toContain('Blocked by Memnox');
  });
});

describe('LocalGateAuthorizer — end to end over the session', () => {
  it('blocks a tool call on its arguments without any runtime', async () => {
    const gate = new LocalGate(
      [
        {
          name: 'no-secrets-in-issues',
          match: { actions: ['mcp.create_issue'] },
          decision: { effect: DECISION_EFFECT.ALLOW },
        },
      ],
      { agentName: 'mcp:github', onSecret: SECRET_RESPONSE.BLOCK },
    );
    const { session: subject, channel } = session(
      new LocalGateAuthorizer(gate, 'github'),
    );

    await subject.fromClient(toolCall({ body: `deploy key ${awsKey}` }));

    expect(channel.server).toHaveLength(0);
    const denial = JSON.stringify(channel.returned());
    expect(denial).toContain('Blocked by Memnox');
    expect(denial).not.toContain(awsKey);
  });

  it('masks the argument in flight when the gate is set to redact', async () => {
    const gate = new LocalGate([], {
      agentName: 'mcp:github',
      onSecret: SECRET_RESPONSE.REDACT,
    });
    const { session: subject, channel } = session(
      new LocalGateAuthorizer(gate, 'github'),
    );

    await subject.fromClient(toolCall({ body: `deploy key ${awsKey}` }));

    const forwarded = JSON.stringify(channel.forwarded());
    expect(forwarded).not.toContain(awsKey);
    expect(forwarded).toContain('redacted-by-memnox');
  });
});
