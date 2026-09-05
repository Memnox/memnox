import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { plainStyle } from '../src/style';
import { registerMcpCommand } from '../src/commands/mcp.command';

async function run(args: string[], home: string): Promise<RecordedOutput> {
  const out = new RecordedOutput();
  const program = new Command();
  registerMcpCommand(program, new CliContext(out, plainStyle), () => home);
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
    expect(out.notes.join('\n')).toContain('already wrapped');
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
