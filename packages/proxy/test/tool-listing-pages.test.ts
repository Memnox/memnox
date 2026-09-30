import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { changingTools, FileToolPins, type McpToolDeclaration } from '@memnox/core';
import { FirewallSession } from '../src/firewall-session';
import { ToolFilter } from '../src/tool-filter';
import { ToolManifest } from '../src/tool-manifest';
import type { CallAuthorizer } from '../src/call-authorizer';

const allowing: CallAuthorizer = {
  authorize: async () => ({ effect: 'allow', reason: 'ok', signals: [] }),
} as never;

const PAGE_ONE = [
  { name: 'list_issues', annotations: { readOnlyHint: true } },
  { name: 'delete_issue', annotations: { destructiveHint: true } },
];
const PAGE_TWO = [{ name: 'create_issue' }, { name: 'merge_pull_request' }];

let home = '';
afterEach(async () => {
  if (home !== '') await rm(home, { recursive: true, force: true });
  home = '';
});

/** One session listing both pages, returning every listing it handed on. */
async function listTwoPages(manifest: ToolManifest): Promise<McpToolDeclaration[][]> {
  const listings: McpToolDeclaration[][] = [];
  const session = new FirewallSession({
    filter: new ToolFilter(undefined, undefined),
    authorizer: allowing,
    channel: { toServer: () => true, toClient: () => undefined },
    log: () => {},
    server: 'github',
    manifest,
    onListing: (tools) => {
      manifest.listed(tools);
      listings.push([...tools]);
    },
  });
  await session.fromClient(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  );
  session.fromServer(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: PAGE_ONE, nextCursor: 'p2' },
    }),
  );
  await session.fromClient(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: { cursor: 'p2' },
    }),
  );
  session.fromServer(
    JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: PAGE_TWO } }),
  );
  return listings;
}

describe('a listing that comes in pages', () => {
  it('is handed on once, with every page, so the manifest holds both', async () => {
    const manifest = new ToolManifest();
    const listings = await listTwoPages(manifest);

    expect(listings).toEqual([[...PAGE_ONE, ...PAGE_TWO]]);
    expect(manifest.declaration('delete_issue')?.annotations).toEqual({
      destructiveHint: true,
    });
    expect(manifest.declaration('create_issue')).toEqual({ name: 'create_issue' });
  });

  it('pins every page, so a second session over the same pages sees nothing arrive', async () => {
    home = await mkdtemp(join(tmpdir(), 'memnox-pages-'));
    const pins = new FileToolPins(home);

    // Every listing handed on is compared, as the firewall does, so a partial one would show.
    for (const listing of await listTwoPages(new ToolManifest())) {
      await pins.compare('github', listing);
    }
    const arrivals = [];
    for (const listing of await listTwoPages(new ToolManifest())) {
      arrivals.push(...changingTools(await pins.compare('github', listing)));
    }
    expect(arrivals).toEqual([]);
  });

  it('abandons a listing whose page failed rather than calling it empty', async () => {
    const listings: McpToolDeclaration[][] = [];
    const session = new FirewallSession({
      filter: new ToolFilter(undefined, undefined),
      authorizer: allowing,
      channel: { toServer: () => true, toClient: () => undefined },
      log: () => {},
      onListing: (tools) => listings.push([...tools]),
    });
    await session.fromClient(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    );
    session.fromServer(
      JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'down' } }),
    );
    expect(listings).toEqual([]);
  });
});
