import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { platform, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { MEMNOX_HOME } from '@memnox/core';

/**
 * The daemon, started by the machine rather than by a terminal somebody remembers to
 * keep open.
 *
 * `syncLoop` only ever ran while `memnox daemon` sat in a foreground shell, so a laptop
 * that had been told "the machine pulls on its own, about once a minute" pulled nothing
 * and nobody found out: the control plane showed a machine that had simply gone quiet.
 * Nothing here is clever — it writes the one service file the platform already knows how
 * to keep alive, and says plainly when the platform has no such thing.
 */

export const SERVICE_LABEL = 'com.memnox.daemon';
const LINUX_UNIT = 'memnox-daemon.service';

interface ServiceState {
  /** False on a platform with no per-user service manager we write for. */
  supported: boolean;
  installed: boolean;
  /** Where the service file is, whether or not it is there yet. */
  path: string;
  /** What the platform calls this, for the sentence a person reads. */
  manager: string;
}

function servicePath(home: string): string {
  return platform() === 'darwin'
    ? join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
    : join(home, '.config', 'systemd', 'user', LINUX_UNIT);
}

export function serviceState(home: string): ServiceState {
  const path = servicePath(home);
  const supported = platform() === 'darwin' || platform() === 'linux';
  return {
    supported,
    installed: supported && existsSync(path),
    path,
    manager: platform() === 'darwin' ? 'launchd' : 'systemd',
  };
}

/**
 * The command the service runs: this node, and this CLI. Resolved through the symlink
 * a global install leaves behind, because a service file naming `~/.local/bin/memnox`
 * stops working the moment the package manager replaces that link.
 */
function commandParts(): { node: string; entry: string } {
  const entry = process.argv[1] ?? '';
  return {
    node: process.execPath,
    entry: entry === '' ? entry : realpathSync(entry),
  };
}

function plistFor(home: string): string {
  const { node, entry } = commandParts();
  const log = join(home, MEMNOX_HOME, 'daemon.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${entry}</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

function unitFor(home: string): string {
  const { node, entry } = commandParts();
  return `[Unit]
Description=Memnox daemon: holds the rules and pulls what the workspace publishes

[Service]
ExecStart=${node} ${entry} daemon
Restart=always
RestartSec=5
Environment=HOME=${home}

[Install]
WantedBy=default.target
`;
}

/** Best effort: the file is the install, and loading it is what makes it start now. */
function load(path: string): string | null {
  try {
    if (platform() === 'darwin') {
      execFileSync('launchctl', ['bootstrap', `gui/${userInfo().uid}`, path], {
        stdio: 'ignore',
      });
      return null;
    }
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    execFileSync('systemctl', ['--user', 'enable', '--now', LINUX_UNIT], {
      stdio: 'ignore',
    });
    return null;
  } catch (error) {
    // Already loaded is the common one, and it is not a failure worth a stack trace.
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Null when it is really stopped, otherwise why not.
 *
 * By label rather than by the plist path: `bootout` takes a path only while the file is
 * still the one launchd loaded, and booting out by path failed silently here — the
 * command reported "Stopped, and this machine no longer starts it" while the daemon it
 * had started was still running half an hour later. A stop that is only announced is
 * worse than one that admits it could not.
 */
function unload(): string | null {
  try {
    if (platform() === 'darwin') {
      execFileSync('launchctl', ['bootout', `gui/${userInfo().uid}/${SERVICE_LABEL}`], {
        stdio: 'ignore',
      });
      return stillLoaded() ? 'the service manager still holds it' : null;
    }
    execFileSync('systemctl', ['--user', 'disable', '--now', LINUX_UNIT], {
      stdio: 'ignore',
    });
    return stillLoaded() ? 'the service manager still holds it' : null;
  } catch (error) {
    /* Not loaded is the state we were asking for, and is not a failure. Checked rather
       than read off the exit code either way: `bootout` answers before the manager has
       finished, and its code says what it was asked to do rather than what is true. */
    if (!stillLoaded()) return null;
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Whether the manager still holds this label, given time to settle. `launchctl` returns
 * before it has finished — measured at several seconds — so asking once reads the old
 * answer and reports a daemon still running that had in fact just stopped. It leaves
 * the moment the label clears, so the budget is only ever spent on one that has not.
 */
const POLL_MS = 250;

function stillLoaded(attempts = 40): boolean {
  for (let left = attempts; left > 0; left -= 1) {
    if (!holdsLabel()) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, POLL_MS);
  }
  return holdsLabel();
}

function holdsLabel(): boolean {
  try {
    if (platform() === 'darwin') {
      execFileSync('launchctl', ['print', `gui/${userInfo().uid}/${SERVICE_LABEL}`], {
        stdio: 'ignore',
      });
      return true;
    }
    execFileSync('systemctl', ['--user', 'is-active', '--quiet', LINUX_UNIT], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

interface InstallResult {
  state: ServiceState;
  /** Set when the file was written but the manager would not take it. */
  warning?: string;
}

/**
 * Injected, so a test writes the file and never asks the real service manager to load
 * something pointing at the test runner.
 */
interface ServiceSeams {
  load?: (path: string) => string | null;
  unload?: () => string | null;
}

export async function installService(
  home: string,
  seams: ServiceSeams = {},
): Promise<InstallResult> {
  const state = serviceState(home);
  if (!state.supported) return { state };

  await mkdir(dirname(state.path), { recursive: true });
  await writeFile(state.path, platform() === 'darwin' ? plistFor(home) : unitFor(home), {
    mode: 0o600,
  });
  const warning = (seams.load ?? load)(state.path);
  return {
    state: { ...state, installed: true },
    ...(warning === null ? {} : { warning }),
  };
}

interface UninstallResult {
  state: ServiceState;
  /** Set when the file is gone but the manager would not let go of what it started. */
  warning?: string;
}

export async function uninstallService(
  home: string,
  seams: ServiceSeams = {},
): Promise<UninstallResult> {
  const state = serviceState(home);
  if (!state.installed) return { state };

  /* Stopped before the file is removed, because the manager needs the label either way
     and a file removed first leaves a running process nothing will admit to. */
  const warning = (seams.unload ?? unload)();
  await rm(state.path, { force: true });
  return {
    state: { ...state, installed: false },
    ...(warning === null ? {} : { warning }),
  };
}
