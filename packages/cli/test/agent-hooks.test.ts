import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  installCursorHook,
  installGeminiHook,
  installWindsurfHook,
  removeCursorHook,
  removeGeminiHook,
  removeWindsurfHook,
} from '../src/protect/agent-hooks';

/* Cursor's hooks file is somebody's editor configuration: a hook they wrote
   survives both directions, and only the entries this wrote are taken out. */
describe("Cursor's hooks file", () => {
  it('adds the hook beside the ones already there and takes only its own out', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-cursor-'));
    await mkdir(join(home, '.cursor'));
    const path = join(home, '.cursor', 'hooks.json');
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        hooks: { afterFileEdit: [{ command: './format.sh' }] },
      }),
    );

    expect(await installCursorHook(home)).toBe(true);
    const installed = JSON.parse(await readFile(path, 'utf8')) as {
      hooks: Record<string, { command: string }[]>;
    };
    expect(installed.hooks['afterFileEdit']?.map((each) => each.command)).toHaveLength(2);

    expect(await removeCursorHook(home)).toBe(true);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      version: 1,
      hooks: { afterFileEdit: [{ command: './format.sh' }] },
    });
  });

  it('writes nothing where Cursor is not installed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-cursor-'));
    expect(await installCursorHook(home)).toBe(false);
  });
});

describe('Gemini CLI and Windsurf settings', () => {
  it("adds the hook to Gemini CLI's settings beside what is there, and takes only its own out", async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-gemini-'));
    await mkdir(join(home, '.gemini'));
    const path = join(home, '.gemini', 'settings.json');
    await writeFile(path, JSON.stringify({ theme: 'dark' }));

    expect(await installGeminiHook(home)).toBe(true);
    const installed = JSON.parse(await readFile(path, 'utf8')) as {
      theme: string;
      hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
    };
    expect(installed.theme).toBe('dark');
    expect(installed.hooks['BeforeTool']?.[0]?.matcher).toBe('write_file|replace');
    expect(installed.hooks['AfterAgent']?.[0]?.hooks[0]?.command).toContain(
      '--agent gemini-cli',
    );

    expect(await removeGeminiHook(home)).toBe(true);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ theme: 'dark' });
  });

  it("adds the hook around Windsurf's writes, reads, commands and MCP calls", async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-windsurf-'));
    await mkdir(join(home, '.codeium', 'windsurf'), { recursive: true });
    const path = join(home, '.codeium', 'windsurf', 'hooks.json');

    expect(await installWindsurfHook(home)).toBe(true);
    const installed = JSON.parse(await readFile(path, 'utf8')) as {
      hooks: Record<string, { command: string }[]>;
    };
    expect(Object.keys(installed.hooks)).toEqual([
      'pre_write_code',
      'post_write_code',
      'post_read_code',
      'post_run_command',
      'post_mcp_tool_use',
    ]);
    expect(installed.hooks['pre_write_code']?.[0]?.command).toContain('--agent windsurf');

    expect(await removeWindsurfHook(home)).toBe(true);
  });
});
