import { describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { parse } from 'jsonc-parser';
import {
  canRewrite,
  MANAGED_SERVER,
  managedServerFor,
  withManagedServer,
  withoutManagedServer,
} from '../src/agents/managed-server';

/**
 * The Memnox entry in the three formats an ordinary laptop actually holds.
 *
 * Codex keeps TOML and Hermes keeps YAML, and declining those meant half the
 * agents Memnox could find were agents it could not govern. What these assert is
 * the property that makes adding a format safe: everything the file held is
 * still there afterwards, and everything a person wrote around it survives.
 */

const server = managedServerFor('https://cloud.memnox.test/mcp', 'tok_123');

const CODEX = `# My Codex setup. Hand edited, and I would like it to stay that way.
model = "o3"

[mcp_servers.node_repl]
command = "node"
args = ["repl.js"]

# The one I use for the docs site
[mcp_servers.docs]
command = "npx"
args = ["docs-mcp"]
`;

const HERMES = `# Hermes, as configured by me
runtime: node

mcp_servers:
  # the good one
  computer_use:
    command: npx
    args: ["computer-use-mcp"]
  notes:
    command: notes-mcp
`;

describe('which configs can be rewritten at all', () => {
  it('takes the three formats the agents on a laptop actually use', () => {
    expect(canRewrite('/home/dev/.claude.json')).toBe(true);
    expect(canRewrite('/home/dev/.codex/config.toml')).toBe(true);
    expect(canRewrite('/home/dev/.hermes/config.yaml')).toBe(true);
    expect(canRewrite('/home/dev/.hermes/config.yml')).toBe(true);
  });

  it('refuses one it has no parser for, rather than guessing', () => {
    expect(canRewrite('/home/dev/.some-agent/config.ini')).toBe(false);
  });
});

describe('Codex, which keeps TOML', () => {
  const written = () =>
    withManagedServer(CODEX, 'mcp_servers', server, '/home/dev/.codex/config.toml')
      .next as string;

  it('adds a server the agent can read back', () => {
    const parsed = parseToml(written()) as Record<string, Record<string, unknown>>;

    expect(parsed['mcp_servers']?.[MANAGED_SERVER]).toMatchObject({
      url: 'https://cloud.memnox.test/mcp',
    });
  });

  it('keeps every server that was already there', () => {
    /* Losing an agent's own servers would be a far worse outcome than not
       onboarding at all. */
    const parsed = parseToml(written()) as Record<string, Record<string, unknown>>;

    expect(Object.keys(parsed['mcp_servers'] ?? {}).sort()).toEqual([
      'docs',
      MANAGED_SERVER,
      'node_repl',
    ]);
  });

  it('keeps the comments and the ordering somebody wrote', () => {
    /* The reason this appends text rather than re-serializing: a round-trip
       through a TOML writer hands back a file that means the same thing and
       looks nothing like the one they wrote. */
    const next = written();

    expect(next).toContain('# My Codex setup. Hand edited');
    expect(next).toContain('# The one I use for the docs site');
    expect(next.indexOf('node_repl')).toBeLessThan(next.indexOf('docs'));
  });

  it('carries the credential where the entry can find it', () => {
    const parsed = parseToml(written()) as Record<string, Record<string, unknown>>;
    const entry = parsed['mcp_servers']?.[MANAGED_SERVER] as Record<string, unknown>;

    expect(entry['http_headers']).toEqual({ Authorization: 'Bearer tok_123' });
  });

  it('replaces its own entry rather than leaving two, which TOML forbids', () => {
    const once = written();
    const twice = withManagedServer(
      once,
      'mcp_servers',
      managedServerFor('https://second/mcp', 'tok_2'),
      '/home/dev/.codex/config.toml',
    ).next as string;

    // Two tables with one name is not valid TOML, so parsing at all proves it.
    const parsed = parseToml(twice) as Record<string, Record<string, unknown>>;
    expect(parsed['mcp_servers']?.[MANAGED_SERVER]).toMatchObject({
      url: 'https://second/mcp',
    });
  });

  it('takes its own entry back out and leaves the rest', () => {
    const removed = withoutManagedServer(
      written(),
      'mcp_servers',
      '/home/dev/.codex/config.toml',
    ).next as string;
    const parsed = parseToml(removed) as Record<string, Record<string, unknown>>;

    expect(parsed['mcp_servers']?.[MANAGED_SERVER]).toBeUndefined();
    expect(Object.keys(parsed['mcp_servers'] ?? {}).sort()).toEqual([
      'docs',
      'node_repl',
    ]);
    expect(removed).toContain('# The one I use for the docs site');
  });

  it('leaves a config that never had one untouched', () => {
    expect(
      withoutManagedServer(CODEX, 'mcp_servers', '/home/dev/.codex/config.toml').next,
    ).toBe(CODEX);
  });

  it('uses whichever spelling of the table the file already uses', () => {
    /* Codex accepts both, and adding the other one would leave a config with
       its servers split across two tables. */
    const older = '[mcpServers.node_repl]\ncommand = "node"\n';

    const next = withManagedServer(
      older,
      'mcp_servers',
      server,
      '/home/dev/.codex/config.toml',
    ).next as string;

    expect(next).toContain(`[mcpServers.${MANAGED_SERVER}]`);
    expect(next).not.toContain(`[mcp_servers.${MANAGED_SERVER}]`);
  });
});

describe('Hermes, which keeps YAML', () => {
  const written = () =>
    withManagedServer(HERMES, 'mcp_servers', server, '/home/dev/.hermes/config.yaml')
      .next as string;

  it('adds a server the agent can read back', () => {
    const parsed = parseYaml(written()) as Record<string, Record<string, unknown>>;

    expect(parsed['mcp_servers']?.[MANAGED_SERVER]).toMatchObject({
      url: 'https://cloud.memnox.test/mcp',
      headers: { Authorization: 'Bearer tok_123' },
    });
  });

  it('keeps every server that was already there', () => {
    const parsed = parseYaml(written()) as Record<string, Record<string, unknown>>;

    expect(Object.keys(parsed['mcp_servers'] ?? {}).sort()).toEqual([
      'computer_use',
      MANAGED_SERVER,
      'notes',
    ]);
  });

  it('keeps the comments, because a Hermes config is edited by hand', () => {
    const next = written();

    expect(next).toContain('# Hermes, as configured by me');
    expect(next).toContain('# the good one');
  });

  it('keeps the keys it knows nothing about', () => {
    const parsed = parseYaml(written()) as Record<string, unknown>;

    expect(parsed['runtime']).toBe('node');
  });

  it('takes its own entry back out and leaves the rest', () => {
    const removed = withoutManagedServer(
      written(),
      'mcp_servers',
      '/home/dev/.hermes/config.yaml',
    ).next as string;
    const parsed = parseYaml(removed) as Record<string, Record<string, unknown>>;

    expect(parsed['mcp_servers']?.[MANAGED_SERVER]).toBeUndefined();
    expect(Object.keys(parsed['mcp_servers'] ?? {}).sort()).toEqual([
      'computer_use',
      'notes',
    ]);
  });

  it('adds the block to a config that declares no servers at all', () => {
    const parsed = parseYaml(
      withManagedServer(
        'runtime: node\n',
        'mcp_servers',
        server,
        '/home/dev/.hermes/config.yaml',
      ).next as string,
    ) as Record<string, Record<string, unknown>>;

    expect(parsed['mcp_servers']?.[MANAGED_SERVER]).toBeDefined();
    expect(parsed['runtime']).toBe('node');
  });
});

/**
 * JSON, which was the format this claimed to support and handled worst.
 *
 * `JSON.parse` threw on the first `//`, so a VS Code or Cline config with one
 * comment in it reported that the agent could not be managed. And a re-serialize
 * rewrote every line, so a four-space config came back two-space and adding four
 * lines produced a diff touching a hundred.
 */
describe('JSON, edited in place', () => {
  const JSONC = `{
  // the one I actually use
  "mcpServers": {
    "github": { "command": "npx", "args": ["github-mcp"] }
  },
  /* keep my editor settings out of this */
  "editor": { "theme": "dark" }
}
`;

  const FOUR_SPACE = `{
    "mcpServers": {
        "github": {
            "command": "npx"
        }
    },
    "editor": {
        "theme": "dark"
    }
}
`;

  it('onboards a config with comments in it', () => {
    /* The gap TOML and YAML had, still open for the two JSON products whose
       own editors allow comments. */
    const result = withManagedServer(
      JSONC,
      'mcpServers',
      server,
      '/home/dev/.vscode/mcp.json',
    );

    expect(result.next).not.toBeNull();
    expect(result.because).toBeUndefined();
  });

  it('keeps those comments afterwards', () => {
    const next = withManagedServer(
      JSONC,
      'mcpServers',
      server,
      '/home/dev/.vscode/mcp.json',
    ).next as string;

    expect(next).toContain('// the one I actually use');
    expect(next).toContain('/* keep my editor settings out of this */');
  });

  it('keeps the indentation the file already uses', () => {
    /* A four-space config coming back two-space is a diff touching every line
       of the file to add four of them. */
    const next = withManagedServer(
      FOUR_SPACE,
      'mcpServers',
      server,
      '/home/dev/.cursor/mcp.json',
    ).next as string;

    expect(next).toContain('\n    "mcpServers"');
    expect(next).toContain('\n        "github"');
  });

  it('leaves every line it did not change exactly as it was', () => {
    const next = withManagedServer(
      FOUR_SPACE,
      'mcpServers',
      server,
      '/home/dev/.cursor/mcp.json',
    ).next as string;

    const before = FOUR_SPACE.split('\n');
    const after = next.split('\n');
    const changed = before.filter((line) => !after.includes(line));
    expect(changed).toEqual([]);
  });

  it('still adds a server the agent can read back', () => {
    const next = withManagedServer(
      JSONC,
      'mcpServers',
      server,
      '/home/dev/.vscode/mcp.json',
    ).next as string;
    const parsed = parse(next, [], { disallowComments: false }) as Record<
      string,
      Record<string, unknown>
    >;

    expect(parsed['mcpServers']?.[MANAGED_SERVER]).toMatchObject({
      type: 'http',
      url: 'https://cloud.memnox.test/mcp',
    });
    expect(parsed['mcpServers']?.['github']).toBeDefined();
    expect(parsed['editor']).toEqual({ theme: 'dark' });
  });

  it('takes its own entry back out and leaves the comments', () => {
    const written = withManagedServer(
      JSONC,
      'mcpServers',
      server,
      '/home/dev/.vscode/mcp.json',
    ).next as string;

    const removed = withoutManagedServer(
      written,
      'mcpServers',
      '/home/dev/.vscode/mcp.json',
    ).next as string;
    const parsed = parse(removed, [], { disallowComments: false }) as Record<
      string,
      Record<string, unknown>
    >;

    expect(parsed['mcpServers']?.[MANAGED_SERVER]).toBeUndefined();
    expect(parsed['mcpServers']?.['github']).toBeDefined();
    expect(removed).toContain('// the one I actually use');
  });

  it('leaves a config that never had one untouched', () => {
    expect(
      withoutManagedServer(JSONC, 'mcpServers', '/home/dev/.vscode/mcp.json').next,
    ).toBe(JSONC);
  });

  it('refuses a config that is not JSON at all', () => {
    const result = withManagedServer(
      'not json at all',
      'mcpServers',
      server,
      '/home/dev/.cursor/mcp.json',
    );

    expect(result.next).toBeNull();
  });
});

describe('a rewrite that would lose something', () => {
  it('refuses a file it could not read in the first place', () => {
    /* Never rewrite what we could not read back: we would lose what it held. */
    const result = withManagedServer(
      'this is not toml [[[',
      'mcp_servers',
      server,
      '/home/dev/.codex/config.toml',
    );

    expect(result.next).toBeNull();
    expect(result.because).toContain('not TOML');
  });

  it('refuses a YAML document that parsed with errors', () => {
    const result = withManagedServer(
      'mcp_servers:\n  a: b\n bad indent here\n',
      'mcp_servers',
      server,
      '/home/dev/.hermes/config.yaml',
    );

    expect(result.next).toBeNull();
  });

  it('refuses a format nothing here parses', () => {
    const result = withManagedServer(
      'whatever',
      'mcp_servers',
      server,
      '/home/dev/.agent/config.ini',
    );

    expect(result.next).toBeNull();
    expect(result.because).toContain('cannot rewrite');
  });
});
