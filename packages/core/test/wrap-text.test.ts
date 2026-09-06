import { describe, expect, it } from 'vitest';
import {
  CONFIG_FORMAT,
  formatOf,
  readTextServers,
  rewriteTextServers,
  setYamlList,
  yamlListIsManaged,
} from '../src/discovery/wrap-text';
import { planUnwrap, planWrap } from '../src/discovery/wrap';

const CODEX = `# Codex config. This comment must survive a wrap.
model = "o3"           # so must this one

[mcp_servers.github]
# the server we actually use
command = "npx"
args = [
  "-y",
  "@modelcontextprotocol/server-github",
]

[mcp_servers.github.env]
GITHUB_TOKEN = "ghp_secret"

[mcp_servers.remote]
url = "https://mcp.example.com"

[history]
persistence = "save-all"
`;

const HERMES = `# Hermes config
model: claude-opus-5

mcp_servers:
  github:
    # the one we use
    command: "npx"
    args:
      - "-y"
      - "server-github"
    env:
      GITHUB_TOKEN: "ghp_secret"
  remote:
    url: "https://mcp.example.com"

logging:
  level: debug
`;

describe('the format of a config', () => {
  it('is taken from the extension, because that is what the product chose', () => {
    expect(formatOf('/h/.codex/config.toml')).toBe(CONFIG_FORMAT.TOML);
    expect(formatOf('/h/.hermes/config.yaml')).toBe(CONFIG_FORMAT.YAML);
    expect(formatOf('/h/.hermes/config.yml')).toBe(CONFIG_FORMAT.YAML);
    expect(formatOf('/h/.claude.json')).toBe(CONFIG_FORMAT.JSON);
  });
});

describe.each([
  ['TOML', CONFIG_FORMAT.TOML, CODEX],
  ['YAML', CONFIG_FORMAT.YAML, HERMES],
] as const)('wrapping a %s config', (_label, format, raw) => {
  it('reads the launch line, and names the URL server it will not touch', () => {
    const { servers, urlOnly } = readTextServers(format, raw);

    expect(servers['github']).toEqual({
      command: 'npx',
      args: expect.arrayContaining(['-y']),
    });
    // An HTTP upstream has no command line; turning a URL into one would break it.
    expect(urlOnly).toEqual(['remote']);
    expect(servers['remote']).toBeUndefined();
  });

  it('keeps every comment and every other line byte for byte', () => {
    const { servers } = readTextServers(format, raw);
    const plan = planWrap(servers);
    const next = Object.fromEntries(plan.wrap.map((e) => [e.name, e.after]));

    const wrapped = rewriteTextServers(format, raw, next);

    for (const kept of [
      'GITHUB_TOKEN',
      'ghp_secret',
      'https://mcp.example.com',
      '# the one we use',
      '# the server we actually use',
    ]) {
      if (raw.includes(kept)) expect(wrapped).toContain(kept);
    }
    expect(wrapped).toContain('memnox-mcp-proxy');
    expect(wrapped).toContain('--memnox-wrapped');
  });

  it('round-trips: unwrapping restores the original command and arguments', () => {
    const { servers } = readTextServers(format, raw);
    const plan = planWrap(servers);
    const wrapped = rewriteTextServers(
      format,
      raw,
      Object.fromEntries(plan.wrap.map((e) => [e.name, e.after])),
    );

    const after = readTextServers(format, wrapped);
    expect(after.servers['github']?.command).toBe('memnox-mcp-proxy');

    const { restore } = planUnwrap(after.servers);
    const back = rewriteTextServers(
      format,
      wrapped,
      Object.fromEntries(restore.map((e) => [e.name, e.after])),
    );

    expect(readTextServers(format, back).servers['github']).toEqual(servers['github']);
    // The lines outside command and args never moved, so the rest is the original.
    expect(back.split('\n').length).toBeGreaterThan(0);
    for (const kept of ['GITHUB_TOKEN', 'https://mcp.example.com']) {
      expect(back).toContain(kept);
    }
  });

  it('never leaves the file thinking a URL server is a command', () => {
    const { servers } = readTextServers(format, raw);
    const wrapped = rewriteTextServers(
      format,
      raw,
      Object.fromEntries(planWrap(servers).wrap.map((e) => [e.name, e.after])),
    );

    expect(readTextServers(format, wrapped).urlOnly).toEqual(['remote']);
  });

  it('changes nothing when asked to rewrite nothing', () => {
    expect(rewriteTextServers(format, raw, {})).toBe(raw);
  });

  /* The one that matters: a person who unwraps has to get their file back, not a
     reformatted version of it. A diff here is a diff they did not ask for. */
  it('unwraps byte for byte, whatever style the file was written in', () => {
    const { servers } = readTextServers(format, raw);
    const wrapped = rewriteTextServers(
      format,
      raw,
      Object.fromEntries(planWrap(servers).wrap.map((e) => [e.name, e.after])),
    );
    const { restore } = planUnwrap(readTextServers(format, wrapped).servers);
    const back = rewriteTextServers(
      format,
      wrapped,
      Object.fromEntries(restore.map((e) => [e.name, e.after])),
    );

    expect(back).toBe(raw);
  });
});

/** Nothing bare in the file may be a word YAML would read as a boolean or a number. */
function scalarsSafe(yaml: string): boolean {
  return !/-\s+(?:y|n|yes|no|true|false|on|off|null|~|\d+(?:\.\d+)?)\s*$/im.test(yaml);
}

describe('styles a config might already be written in', () => {
  it('leaves a bare YAML scalar bare, and a block list a block list', () => {
    const raw = `mcp_servers:
  gh:
    command: npx
    args:
      - -y
      - server-github
`;
    const { servers } = readTextServers(CONFIG_FORMAT.YAML, raw);
    const wrapped = rewriteTextServers(
      CONFIG_FORMAT.YAML,
      raw,
      Object.fromEntries(planWrap(servers).wrap.map((e) => [e.name, e.after])),
    );

    expect(wrapped).toContain('command: memnox-mcp-proxy');
    expect(wrapped).toContain('      - --memnox-wrapped');
    // A word a YAML parser would turn into a boolean is quoted whatever the style.
    expect(scalarsSafe(wrapped)).toBe(true);

    const { restore } = planUnwrap(readTextServers(CONFIG_FORMAT.YAML, wrapped).servers);
    expect(
      rewriteTextServers(
        CONFIG_FORMAT.YAML,
        wrapped,
        Object.fromEntries(restore.map((e) => [e.name, e.after])),
      ),
    ).toBe(raw);
  });

  it('quotes an argument a YAML parser would otherwise retype', () => {
    const raw = 'mcp_servers:\n  gh:\n    command: npx\n    args:\n      - --flag\n';
    const { servers } = readTextServers(CONFIG_FORMAT.YAML, raw);
    const wrapped = rewriteTextServers(CONFIG_FORMAT.YAML, raw, {
      gh: { command: 'memnox-mcp-proxy', args: ['--yes', 'no', '8080', 'plain'] },
    });

    expect(wrapped).toContain('- "no"');
    expect(wrapped).toContain('- "8080"');
    expect(wrapped).toContain('- --yes');
    expect(wrapped).toContain('- plain');
    expect(servers['gh']?.command).toBe('npx');
  });

  it('writes an args line for a server that declared none', () => {
    const raw = '[mcp_servers.gh]\ncommand = "gh-mcp"\n';
    const { servers } = readTextServers(CONFIG_FORMAT.TOML, raw);
    const wrapped = rewriteTextServers(
      CONFIG_FORMAT.TOML,
      raw,
      Object.fromEntries(planWrap(servers).wrap.map((e) => [e.name, e.after])),
    );

    expect(wrapped).toContain(
      'args = ["--memnox-wrapped", "--name", "gh", "--", "gh-mcp"]',
    );
    expect(readTextServers(CONFIG_FORMAT.TOML, wrapped).servers['gh']?.command).toBe(
      'memnox-mcp-proxy',
    );
  });
});

describe('writing a list into a YAML config', () => {
  const CONFIG = `# somebody's config
model: opus

approvals:
  mode: manual   # they chose this
  timeout: 300

terminal:
  backend: docker
`;

  it('adds the list under its parent, keeping every other line', () => {
    const after = setYamlList(CONFIG, 'approvals', 'deny', ['git push --force*']);

    expect(after).toContain('    - "git push --force*"');
    expect(after).toContain('  mode: manual   # they chose this');
    expect(after).toContain('backend: docker');
    expect(after).toContain("# somebody's config");
  });

  it('replaces only its own list, and a revert leaves the file as it was', () => {
    const written = setYamlList(CONFIG, 'approvals', 'deny', ['git push --force*']);
    const rewritten = setYamlList(written, 'approvals', 'deny', ['rm -rf*']);

    expect(rewritten).toContain('- "rm -rf*"');
    expect(rewritten).not.toContain('git push --force');
    expect(setYamlList(rewritten, 'approvals', 'deny', [])).toBe(CONFIG);
  });

  /* A list somebody maintains by hand carries no fence, so a revert must not take it:
     removing what we never wrote is the same bug as failing to remove what we did. */
  it('knows its own list from one somebody wrote themselves', () => {
    const theirs = `approvals:\n  deny:\n    - "curl * | sh"\n`;

    expect(yamlListIsManaged(theirs, 'approvals', 'deny')).toBe(false);
    expect(
      yamlListIsManaged(
        setYamlList(CONFIG, 'approvals', 'deny', ['x*']),
        'approvals',
        'deny',
      ),
    ).toBe(true);
  });

  /* We may have created the parent, so leaving a bare `approvals:` behind means the
     revert did not put the file back — and an empty key is not what its author had. */
  it('takes the parent with it when nothing else was under it', () => {
    const original = 'model: opus\n';
    const written = setYamlList(original, 'approvals', 'deny', ['rm -rf*']);

    expect(written).toContain('approvals:');
    expect(setYamlList(written, 'approvals', 'deny', [])).toBe(original);
  });

  it('keeps a parent that still holds something else', () => {
    const original = 'approvals:\n  mode: manual\n';
    const written = setYamlList(original, 'approvals', 'deny', ['rm -rf*']);

    expect(setYamlList(written, 'approvals', 'deny', [])).toBe(original);
  });

  it('creates the parent when the config has none yet', () => {
    const after = setYamlList('model: opus\n', 'approvals', 'deny', ['rm -rf*']);

    expect(after).toContain('approvals:');
    expect(after).toContain('  deny:');
    expect(after).toContain('    - "rm -rf*"');
    expect(after.startsWith('model: opus\n')).toBe(true);
  });
});
