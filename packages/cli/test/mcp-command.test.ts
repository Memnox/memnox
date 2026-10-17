import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { plainStyle } from '../src/style';
import { registerMcpCommand } from '../src/commands/mcp.command';

async function run(
  args: string[],
  home: string,
  proxyPresent = true,
): Promise<RecordedOutput> {
  const out = new RecordedOutput();
  const program = new Command();
  registerMcpCommand(program, new CliContext(out, plainStyle), {
    home: () => home,
    resolveBinary: () => proxyPresent,
  });
  await program.parseAsync(args, { from: 'user' });
  return out;
}

const CONFIG = {
  mcpServers: {
    github: { command: 'npx', args: ['-y', 'gh-mcp'], env: { GITHUB_TOKEN: 'x' } },
  },
  otherSetting: true,
};

async function machine(config: unknown = CONFIG): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'memnox-wrap-'));
  await writeFile(join(home, '.claude.json'), `${JSON.stringify(config, null, 2)}\n`);
  return home;
}

const read = async (home: string): Promise<Record<string, never>> =>
  JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')) as Record<string, never>;

describe('memnox mcp wrap', () => {
  it('repoints the server and says what it did', async () => {
    const home = await machine();
    const out = await run(['mcp', 'wrap'], home);

    expect(out.text).toContain('github  npx → proxy');
    const after = (await read(home)) as unknown as typeof CONFIG;
    expect(after.mcpServers.github.command).toBe('memnox-mcp-proxy');
  });

  it('keeps everything else in the file untouched', async () => {
    const home = await machine();
    await run(['mcp', 'wrap'], home);
    expect((await read(home)) as unknown as { otherSetting: boolean }).toMatchObject({
      otherSetting: true,
    });
  });

  it('restores byte-identically, which is the whole promise', async () => {
    const home = await machine();
    const before = await readFile(join(home, '.claude.json'), 'utf8');

    await run(['mcp', 'wrap'], home);
    await run(['mcp', 'unwrap'], home);

    expect(await readFile(join(home, '.claude.json'), 'utf8')).toBe(before);
  });

  it('writes a backup holding the file exactly as it was', async () => {
    const home = await machine();
    const before = await readFile(join(home, '.claude.json'), 'utf8');
    await run(['mcp', 'wrap'], home);

    const backups = join(home, '.memnox', 'backup');
    const names = await readdir(backups);
    expect(names).toHaveLength(1);
    expect(await readFile(join(backups, names[0] as string), 'utf8')).toBe(before);
  });

  it('changes nothing on --dry-run', async () => {
    const home = await machine();
    const before = await readFile(join(home, '.claude.json'), 'utf8');
    const out = await run(['mcp', 'wrap', '--dry-run'], home);

    expect(out.text).toContain('Nothing was changed.');
    expect(await readFile(join(home, '.claude.json'), 'utf8')).toBe(before);
  });

  it('never wraps twice, because a nested proxy starts nothing', async () => {
    const home = await machine();
    await run(['mcp', 'wrap'], home);
    const once = await readFile(join(home, '.claude.json'), 'utf8');

    const out = await run(['mcp', 'wrap'], home);
    expect(out.text).toContain('is already wrapped');
    expect(await readFile(join(home, '.claude.json'), 'utf8')).toBe(once);
  });

  it('says so plainly when there is no MCP config at all', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-bare-'));
    const out = await run(['mcp', 'wrap'], home);
    expect(out.text).toContain('nothing to wrap');
  });

  it('refuses to rewrite a config it could not parse', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-broken-'));
    await writeFile(join(home, '.claude.json'), '{ not json');
    const out = await run(['mcp', 'wrap'], home);

    expect(out.text).toContain('nothing to wrap');
    expect(await readFile(join(home, '.claude.json'), 'utf8')).toBe('{ not json');
  });

  it('leaves a server somebody else configured alone on unwrap', async () => {
    const home = await machine();
    const out = await run(['mcp', 'unwrap'], home);
    expect(out.text).toContain('nothing was changed');
  });
});

describe('before it touches a single config', () => {
  it('refuses when the proxy is not on PATH, because wrapping would stop the agent starting', async () => {
    const home = await machine();
    const before = await readFile(join(home, '.claude.json'), 'utf8');

    await expect(run(['mcp', 'wrap'], home, false)).rejects.toThrow(/not on PATH/);
    expect(await readFile(join(home, '.claude.json'), 'utf8')).toBe(before);
  });

  it('says how to fix it rather than only that it failed', async () => {
    await expect(run(['mcp', 'wrap'], await machine(), false)).rejects.toThrow(
      /npm install -g memnox/,
    );
  });

  it('still shows a dry run, which changes nothing and so is always safe', async () => {
    const out = await run(['mcp', 'wrap', '--dry-run'], await machine(), false);
    expect(out.text).toContain('Nothing was changed.');
  });
});

/* `mcp wrap` read configs with JSON.parse, so a VS Code or Cline file with a single `//`
   comment was skipped and its servers never governed; and it wrote with
   JSON.stringify(_, null, 2), so a four-space file came back two-space, every line changed. */
describe('a config written by hand', () => {
  // Four spaces, comments, a trailing comma and an inline array: what an editor leaves.
  const HANDWRITTEN = `{
    // the servers this project trusts
    "mcpServers": {
        "github": {
            "command": "npx",
            "args": ["-y", "gh-mcp"], // pinned on purpose
        },
        "docs": { "command": "docs-mcp" }
    },
    /* not ours */
    "theme": "dark"
}
`;

  // Strict JSON, which the old reader did parse — and then rewrote at two spaces.
  const PLAIN = `{
    "mcpServers": {
        "github": {
            "command": "npx",
            "args": ["-y", "gh-mcp"]
        },
        "docs": { "command": "docs-mcp" }
    },
    "theme": "dark"
}
`;

  async function handwritten(content = HANDWRITTEN): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'memnox-wrap-'));
    await writeFile(join(home, '.claude.json'), content);
    return home;
  }

  const text = (home: string): Promise<string> =>
    readFile(join(home, '.claude.json'), 'utf8');

  it('wraps a file with comments, and the comments survive', async () => {
    const home = await handwritten();

    const out = await run(['mcp', 'wrap'], home);
    const after = await text(home);

    expect(out.text).toContain('github  npx → proxy');
    expect(after).toContain('memnox-mcp-proxy');
    for (const comment of ['// the servers this project trusts', '/* not ours */'])
      expect(after).toContain(comment);
  });

  it.each([
    ['with comments', HANDWRITTEN],
    ['in plain JSON', PLAIN],
  ])(
    'keeps four spaces four %s, changing only the wrapped entry',
    async (_how, content) => {
      const home = await handwritten(content);

      await run(['mcp', 'wrap'], home);
      const before = content.split('\n');
      const after = (await text(home)).split('\n');

      expect(after).not.toEqual(before);
      // Everything up to the wrapped entry, and everything after it, line for line.
      const at = before.findIndex((line) => line.includes('"github"'));
      expect(after.slice(0, at + 1)).toEqual(before.slice(0, at + 1));
      const docs = before.findIndex((line) => line.includes('"docs"'));
      expect(after.slice(after.findIndex((line) => line.includes('"docs"')))).toEqual(
        before.slice(docs),
      );
      expect(after.filter((line) => /^ {2}"/.test(line))).toEqual([]);
    },
  );

  it.each([
    ['with comments', HANDWRITTEN],
    ['in plain JSON', PLAIN],
  ])('unwraps %s to the very bytes it started from', async (_how, content) => {
    const home = await handwritten(content);

    await run(['mcp', 'wrap'], home);
    await run(['mcp', 'unwrap'], home);

    expect(await text(home)).toBe(content);
  });

  it('leaves a file that will not parse even as JSONC exactly alone', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-wrap-'));
    const broken = '{ "mcpServers": { "github": { "command": "npx" ';
    await writeFile(join(home, '.claude.json'), broken);

    await run(['mcp', 'wrap'], home);

    expect(await text(home)).toBe(broken);
  });
});
