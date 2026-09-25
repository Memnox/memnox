import { describe, expect, it, vi } from 'vitest';
import { FirewallSession } from '../src/firewall-session';
import { ToolFilter } from '../src/tool-filter';
import type { CallAuthorizer } from '../src/call-authorizer';

const allowing: CallAuthorizer = {
  authorize: async () => ({ effect: 'allow', reason: 'ok', signals: [] }),
} as never;

describe('what a server lists', () => {
  it('is handed on whole, before the filter hides anything, with its annotations', async () => {
    const onListing = vi.fn();
    const session = new FirewallSession({
      filter: new ToolFilter(undefined, 'redeploy*'),
      authorizer: allowing,
      channel: { toServer: () => true, toClient: () => undefined },
      log: () => {},
      server: 'railway',
      onListing,
    });
    await session.fromClient(
      JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
    );
    session.fromServer(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        result: {
          tools: [
            { name: 'list_deployments', annotations: { readOnlyHint: true } },
            { name: 'redeploy_service' },
          ],
        },
      }),
    );
    expect(onListing).toHaveBeenCalledWith([
      { name: 'list_deployments', annotations: { readOnlyHint: true } },
      { name: 'redeploy_service' },
    ]);
  });
});
