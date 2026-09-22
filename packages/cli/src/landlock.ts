/**
 * Landlock applied for real: a syscall rather than a file, so a small python3 helper
 * creates the ruleset from a plan, restricts itself and then execs the agent. Detected
 * by asking the kernel, never by version alone, and said plainly where it is missing.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { guardFor, MEMNOX_HOME, OS_GUARD, type CarveEntry } from '@memnox/core';

/** The interpreter the helper runs under; present on nearly every Linux that has Landlock. */
const LANDLOCK_PYTHON = 'python3';

const GUARD_DIR = 'guard';
const HELPER_FILE = 'landlock-exec.py';
const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_DIR = 0o700;

/** Long enough for python to start, short enough that a hung probe never holds a run. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * The helper, kept as data so it ships inside the CLI. Access bits and syscall numbers are
 * the kernel's own (include/uapi/linux/landlock.h), identical on x86_64 and arm64.
 */
const LANDLOCK_HELPER = String.raw`import ctypes, json, os, sys
CREATE, ADD, RESTRICT = 444, 445, 446
PATH_BENEATH, NET_PORT = 1, 2
CONNECT_TCP = 1 << 1
EXECUTE, WRITE_FILE, READ_FILE, READ_DIR = 1, 1 << 1, 1 << 2, 1 << 3
TRUNCATE, IOCTL_DEV = 1 << 14, 1 << 15
READ = EXECUTE | READ_FILE | READ_DIR
FILE_ONLY = EXECUTE | WRITE_FILE | READ_FILE | TRUNCATE | IOCTL_DEV
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
class RulesetAttr(ctypes.Structure):
    _fields_ = [("fs", ctypes.c_uint64), ("net", ctypes.c_uint64)]
class PathBeneath(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed", ctypes.c_uint64), ("fd", ctypes.c_int32)]
class NetPort(ctypes.Structure):
    _fields_ = [("allowed", ctypes.c_uint64), ("port", ctypes.c_uint64)]
def fail(message):
    sys.stderr.write("memnox: landlock: " + message + "\n")
    sys.exit(126)
def abi():
    found = libc.syscall(ctypes.c_long(CREATE), None, ctypes.c_size_t(0), ctypes.c_uint32(1))
    return found if found > 0 else 0
def handled_fs(version):
    bits = (1 << 13) - 1
    if version >= 2: bits |= 1 << 13
    if version >= 3: bits |= TRUNCATE
    if version >= 5: bits |= IOCTL_DEV
    return bits
def add_path(ruleset, path, access, handled):
    try:
        fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
    except OSError:
        return
    try:
        if not os.path.isdir(path):
            access &= FILE_ONLY
        rule = PathBeneath(access & handled, fd)
        if libc.syscall(ctypes.c_long(ADD), ctypes.c_long(ruleset), ctypes.c_long(PATH_BENEATH), ctypes.byref(rule), ctypes.c_uint32(0)) != 0:
            fail("could not grant " + path)
    finally:
        os.close(fd)
def apply(plan, version):
    handled = handled_fs(version)
    ports = plan.get("connectPorts")
    net = CONNECT_TCP if version >= 4 and ports is not None else 0
    attr = RulesetAttr(handled, net)
    size = 16 if version >= 4 else 8
    ruleset = libc.syscall(ctypes.c_long(CREATE), ctypes.byref(attr), ctypes.c_size_t(size), ctypes.c_uint32(0))
    if ruleset < 0:
        fail("the kernel refused a ruleset")
    for path in plan["read"]:
        add_path(ruleset, path, READ, handled)
    for path in plan["write"]:
        add_path(ruleset, path, handled, handled)
    for port in (ports or []) if net else []:
        rule = NetPort(CONNECT_TCP, port)
        libc.syscall(ctypes.c_long(ADD), ctypes.c_long(ruleset), ctypes.c_long(NET_PORT), ctypes.byref(rule), ctypes.c_uint32(0))
    if libc.prctl(38, 1, 0, 0, 0) != 0:
        fail("no_new_privs was refused")
    if libc.syscall(ctypes.c_long(RESTRICT), ctypes.c_long(ruleset), ctypes.c_uint32(0)) != 0:
        fail("restrict_self was refused")
    os.close(ruleset)
if sys.argv[1] == "--abi":
    print(abi())
    sys.exit(0)
version = abi()
if version < 1:
    fail("this kernel does not enforce Landlock")
with open(sys.argv[1]) as handle:
    apply(json.load(handle), version)
os.execvp(sys.argv[3], sys.argv[3:])
`;

/** What a run can say about Landlock here: the ABI the kernel answered, or why there is none. */
interface LandlockSupport {
  abi: number | null;
  because: string;
}

/** The first ABI whose rulesets can hold TCP connect. */
const LANDLOCK_NETWORK_ABI = 4;

export interface LandlockSeams {
  platform?: string;
  kernel?: string;
  /** Asks the kernel through the helper; null where python3 or the helper will not run. */
  probe?: (helper: string) => number | null;
}

/** Feature detection: the platform, the kernel version, then the kernel itself. */
export function landlockSupport(
  home: string,
  kernel: string,
  seams: LandlockSeams = {},
): LandlockSupport {
  const support = guardFor(seams.platform ?? process.platform, seams.kernel ?? kernel);
  if (support.guard !== OS_GUARD.LANDLOCK) return { abi: null, because: support.because };
  const helper =
    seams.probe === undefined ? installLandlockHelper(home) : landlockHelperPath(home);
  const abi = (seams.probe ?? probeAbi)(helper);
  if (abi === null) {
    return {
      abi: null,
      because: `${LANDLOCK_PYTHON} is not here to apply the ruleset, so the kernel holds nothing`,
    };
  }
  if (abi < 1) {
    return {
      abi: null,
      because:
        'the kernel has Landlock turned off (not in its lsm= list), so it holds nothing',
    };
  }
  const network =
    abi >= LANDLOCK_NETWORK_ABI
      ? 'files and TCP connect'
      : 'files only, since TCP needs Landlock ABI 4 (Linux 6.7)';
  return { abi, because: `Landlock ABI ${abi} holds ${network}` };
}

/** The command that runs `command` under the plan at `plan`. */
export function landlockCommand(
  home: string,
  plan: string,
  command: readonly string[],
): string[] {
  return [LANDLOCK_PYTHON, landlockHelperPath(home), plan, '--', ...command];
}

function landlockHelperPath(home: string): string {
  return join(home, MEMNOX_HOME, GUARD_DIR, HELPER_FILE);
}

/** Written on every run rather than once, so an upgraded CLI never runs an old helper. */
function installLandlockHelper(home: string): string {
  const path = landlockHelperPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: OWNER_ONLY_DIR });
  writeFileSync(path, LANDLOCK_HELPER, { encoding: 'utf8', mode: OWNER_ONLY_FILE });
  return path;
}

function probeAbi(helper: string): number | null {
  const answer = spawnSync(LANDLOCK_PYTHON, [helper, '--abi'], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
  });
  if (answer.status !== 0) return null;
  const abi = Number.parseInt(answer.stdout.trim(), 10);
  return Number.isNaN(abi) ? null : abi;
}

/** The directory lister carving needs, with links marked so they are never granted. */
export function listDirectory(dir: string): CarveEntry[] {
  try {
    return readdirSync(dir).map((name) => ({ name, symlink: isLink(join(dir, name)) }));
  } catch {
    // Unreadable is empty: nothing under it is granted, which is the safe side.
    return [];
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return true;
  }
}
