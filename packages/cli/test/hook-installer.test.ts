import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOOK_EVENT_NAME } from '@memnox/tool-hook';
import { HOOK_MATCHER, HookInstaller, MEMNOX_HOOK_MARKER } from '../src/hook-installer';

const COMMAND = '/usr/bin/node /opt/memnox/tool-hook/cli.js';

function home(settings?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'memnox-hooks-'));
  if (settings !== undefined) {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(settings));
  }
  return dir;
}

function settingsOf(installer: HookInstaller): Record<string, unknown> {
  return JSON.parse(readFileSync(installer.settingsPath, 'utf8')) as Record<
    string,
    unknown
  >;
}

function entries(installer: HookInstaller): Record<string, unknown>[] {
  const hooks = settingsOf(installer)['hooks'] as Record<string, unknown>;
  return (hooks[HOOK_EVENT_NAME] ?? []) as Record<string, unknown>[];
}

/** Somebody else's hook, with fields we have no schema for. */
const foreign = {
  matcher: 'Bash',
  hooks: [{ type: 'command', command: './block-rm.sh', if: 'Bash(rm *)', args: [] }],
};

describe('HookInstaller', () => {
  it('writes an entry matching every tool the seam rules on', async () => {
    const installer = new HookInstaller(home(), COMMAND);
    const report = await installer.install();

    expect(report.installed).toBe(true);
    const written = entries(installer);
    expect(written).toHaveLength(1);
    expect(written[0]?.['matcher']).toBe(HOOK_MATCHER);
    expect(HOOK_MATCHER).toContain('Read');
    expect(HOOK_MATCHER).toContain('Bash');
  });

  it('is idempotent — running setup twice changes nothing', async () => {
    const installer = new HookInstaller(home(), COMMAND);
    await installer.install();
    const second = await installer.install();

    expect(second.installed).toBe(false);
    expect(entries(installer)).toHaveLength(1);
  });

  it('repoints its own entry when the binary moves, without leaving two gates', async () => {
    const dir = home();
    await new HookInstaller(dir, '/old/node /old/cli.js').install();
    const upgraded = new HookInstaller(dir, COMMAND);
    await upgraded.install();

    const written = entries(upgraded);
    expect(written).toHaveLength(1);
    expect(await upgraded.installedCommand()).toBe(COMMAND);
  });

  it('carries a foreign hook through byte for byte', async () => {
    const installer = new HookInstaller(
      home({ hooks: { [HOOK_EVENT_NAME]: [foreign] } }),
      COMMAND,
    );
    await installer.install();

    const written = entries(installer);
    expect(written).toHaveLength(2);
    expect(written[0]).toEqual(foreign);
  });

  it('leaves unrelated settings alone', async () => {
    const installer = new HookInstaller(
      home({ model: 'opus', env: { A: '1' } }),
      COMMAND,
    );
    await installer.install();

    const settings = settingsOf(installer);
    expect(settings['model']).toBe('opus');
    expect(settings['env']).toEqual({ A: '1' });
  });

  it('uninstall removes only ours, and reports when there was nothing to remove', async () => {
    const installer = new HookInstaller(
      home({ hooks: { [HOOK_EVENT_NAME]: [foreign] } }),
      COMMAND,
    );
    expect(await installer.uninstall()).toBe(false);

    await installer.install();
    expect(await installer.uninstall()).toBe(true);
    expect(entries(installer)).toEqual([foreign]);
  });

  it('leaves no empty gate behind when it was the only hook', async () => {
    const installer = new HookInstaller(home(), COMMAND);
    await installer.install();
    await installer.uninstall();

    expect(settingsOf(installer)['hooks']).toBeUndefined();
  });

  it('reads what is installed off the file rather than assuming', async () => {
    const installer = new HookInstaller(home(), COMMAND);
    expect(await installer.installedCommand()).toBeNull();

    await installer.install();
    expect(await installer.installedCommand()).toBe(COMMAND);
  });

  it('marks its entry so uninstall finds it wherever the binary lives', async () => {
    const installer = new HookInstaller(home(), COMMAND);
    await installer.install();

    const handlers = entries(installer)[0]?.['hooks'] as Record<string, unknown>[];
    expect(handlers[0]?.['statusMessage']).toBe(MEMNOX_HOOK_MARKER);
  });

  it('survives settings that are not the shape it expects', async () => {
    const installer = new HookInstaller(home({ hooks: 'nonsense' }), COMMAND);
    const report = await installer.install();
    expect(report.installed).toBe(true);
    expect(entries(installer)).toHaveLength(1);
  });
});
