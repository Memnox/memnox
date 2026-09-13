import { mkdtemp, readFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  installService,
  SERVICE_LABEL,
  serviceState,
  uninstallService,
} from '../src/daemon/service';

/**
 * `syncLoop` ran only while `memnox daemon` sat in a foreground shell, so a workspace
 * that told somebody "the machine pulls on its own, about once a minute" described a
 * loop nothing started. A machine that quietly stopped syncing looks exactly like one
 * with nothing to report.
 */
describe('having the machine start the daemon', () => {
  const home = () => mkdtemp(join(tmpdir(), 'memnox-svc-'));

  it('reports that nothing starts it before anything is installed', async () => {
    expect(serviceState(await home()).installed).toBe(false);
  });

  it('writes the service file its platform understands, and takes it back', async () => {
    const dir = await home();
    // Never the real launchctl or systemctl: this file names the test runner.
    const { state } = await installService(dir, { load: () => null });
    if (!state.supported) return;

    expect(state.installed).toBe(true);
    expect(serviceState(dir).installed).toBe(true);

    const written = await readFile(state.path, 'utf8');
    // It has to actually run the daemon, or it is a file that keeps nothing alive.
    expect(written).toContain('daemon');
    expect(written).toContain(platform() === 'darwin' ? SERVICE_LABEL : 'Restart=always');

    expect((await uninstallService(dir, { unload: () => null })).state.installed).toBe(
      false,
    );
    expect(serviceState(dir).installed).toBe(false);
  });

  it('removing one that was never installed is not an error', async () => {
    await expect(uninstallService(await home())).resolves.toBeDefined();
  });

  it('admits it when the manager would not stop what it started', async () => {
    const dir = await home();
    await installService(dir, { load: () => null });
    // A stop that is only announced leaves a daemon running that nothing owns up to.
    const { state, warning } = await uninstallService(dir, {
      unload: () => 'launchctl refused',
    });
    expect(state.installed).toBe(false);
    expect(warning).toBe('launchctl refused');
  });
});
