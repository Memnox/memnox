import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { platform, userInfo } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { MEMNOX_HOME } from '@memnox/core';
import { interceptorDirFor } from '@memnox/interceptors';
import { describeError } from '../cli-errors';

/**
 * The daemon, started by the machine rather than a terminal somebody keeps open, or a
 * laptop that stopped syncing looks like one with nothing to report.
 */

export const SERVICE_LABEL = 'com.memnox.daemon';
const LINUX_UNIT = 'memnox-daemon.service';
const SERVICE_FILE_MODE = 0o600;
const STILL_HELD = 'the service manager still holds it';

interface ServiceState {
  /** False on a platform with no per-user service manager we write for. */
  supported: boolean;
  installed: boolean;
  /** Where the service file is, whether or not it is there yet. */
  path: string;
  /** What the platform calls this, for the sentence a person reads. */
  manager: string;
}

/** The two platforms that ship a per-user service manager this can write a file for. */
const MACOS = 'darwin';
const LINUX = 'linux';

/** macOS means launchd and a plist; everything else supported means systemd and a unit. */
function isMac(): boolean {
  return platform() === MACOS;
}

function servicePath(home: string): string {
  return isMac()
    ? join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
    : join(home, '.config', 'systemd', 'user', LINUX_UNIT);
}

export function serviceState(home: string): ServiceState {
  const path = servicePath(home);
  const supported = isMac() || platform() === LINUX;
  return {
    supported,
    installed: supported && existsSync(path),
    path,
    manager: isMac() ? 'launchd' : 'systemd',
  };
}

/**
 * The command the service runs: this node, and this CLI. Resolved through the symlink
 * a global install leaves behind, because a service file naming `~/.local/bin/memnox`
 * stops working the moment the package manager replaces that link.
 */
function resolveCommandParts(): { node: string; entry: string } {
  const entry = process.argv[1] ?? '';
  return {
    node: process.execPath,
    entry: entry === '' ? entry : realpathSync(entry),
  };
}

/**
 * The PATH of the shell that ran setup, because launchd and systemd start the daemon with
 * a bare one, and the daemon wraps a new MCP server only where it can find the proxy.
 */
function installingPath(home: string): string {
  // Without the interceptors, or the daemon's own git calls would be put to the gate.
  const ours = interceptorDirFor(home);
  return (process.env['PATH'] ?? '')
    .split(delimiter)
    .filter((dir) => dir !== '' && dir !== ours)
    .join(delimiter);
}

function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function plistFor(home: string): string {
  const { node, entry } = resolveCommandParts();
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
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escapeXml(installingPath(home))}</string>
  </dict>
</dict>
</plist>
`;
}

function unitFor(home: string): string {
  const { node, entry } = resolveCommandParts();
  return `[Unit]
Description=Memnox daemon: holds the rules and pulls what the workspace publishes

[Service]
ExecStart=${node} ${entry} daemon
Restart=always
RestartSec=5
Environment=HOME=${home}
Environment="PATH=${installingPath(home)}"

[Install]
WantedBy=default.target
`;
}

/** Best effort: the file is the install, and loading it is what makes it start now. */
function load(path: string): string | null {
  try {
    if (isMac()) {
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
    return describeError(error);
  }
}

/**
 * Null when it is really stopped, otherwise why not. By label rather than by path, since
 * `bootout` takes a path only while the file is the one launchd loaded.
 */
function unload(): string | null {
  try {
    if (isMac()) {
      execFileSync('launchctl', ['bootout', `gui/${userInfo().uid}/${SERVICE_LABEL}`], {
        stdio: 'ignore',
      });
      return isStillLoaded() ? STILL_HELD : null;
    }
    execFileSync('systemctl', ['--user', 'disable', '--now', LINUX_UNIT], {
      stdio: 'ignore',
    });
    return isStillLoaded() ? STILL_HELD : null;
  } catch (error) {
    // Not loaded is what we asked for; checked rather than read off the exit code, since
    // `bootout` answers before the manager has finished.
    if (!isStillLoaded()) return null;
    return describeError(error);
  }
}

const POLL_MS = 250;

/** Ten seconds of polling, which is longer than `launchctl` has ever taken to settle. */
const SETTLE_ATTEMPTS = 40;

/** One 32-bit slot, which is the smallest thing `Atomics.wait` can block on. */
const SLEEP_SLOT_BYTES = 4;

/** Blocks this thread without a timer, because the caller is a synchronous command. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(SLEEP_SLOT_BYTES)), 0, 0, ms);
}

/**
 * Whether the manager still holds this label, given time to settle, because `launchctl`
 * returns seconds before it has finished. It leaves the moment the label clears.
 */
function isStillLoaded(attempts = SETTLE_ATTEMPTS): boolean {
  for (let left = attempts; left > 0; left -= 1) {
    if (!isLabelLoaded()) return false;
    sleepSync(POLL_MS);
  }
  return isLabelLoaded();
}

function isLabelLoaded(): boolean {
  try {
    if (isMac()) {
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

export interface InstallResult {
  state: ServiceState;
  /** Set when the file was written but the manager would not take it. */
  warning?: string;
}

/** Injected, so a test never asks the real service manager to load the test runner. */
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
  await writeFile(state.path, isMac() ? plistFor(home) : unitFor(home), {
    mode: SERVICE_FILE_MODE,
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

  // Stopped before the file goes, or a running process is left that nothing admits to.
  const warning = (seams.unload ?? unload)();
  await rm(state.path, { force: true });
  return {
    state: { ...state, installed: false },
    ...(warning === null ? {} : { warning }),
  };
}
