import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  MEMNOX_HOME,
  PROOF,
  PROXY_BINARY,
  SURFACE_KIND,
  type SeamProof,
} from '@memnox/core';
import { guardProfilePath } from '../memnox-paths';
import { INTERCEPT_BINARY, interceptorDirFor } from '@memnox/interceptors';

const run = promisify(execFile);

/** Long enough for a cold Node start, short enough that a wedged seam is a result. */
const PROBE_MS = 10_000;

/**
 * A rule nothing else on the machine has, so a pass cannot come from the reader's own
 * policy and a failure cannot be somebody else's rule being lenient.
 */
const PROBE_RULES = `version = 1

[[policies]]
name = "memnox-self-test"
match = { actions = ["git.push-force", "mcp.memnox_selftest_delete"] }
decision = { effect = "deny", reason = "memnox self test" }
`;

/** A stdio MCP server that answers, so a call that is not refused visibly succeeds. */
const STUB_SERVER = `
let buf='';process.stdin.on('data',d=>{buf+=d;let i;
while((i=buf.indexOf('\\n'))!==-1){const l=buf.slice(0,i);buf=buf.slice(i+1);
if(!l.trim())continue;const m=JSON.parse(l);
const send=o=>process.stdout.write(JSON.stringify(o)+'\\n');
if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'selftest',version:'1'}}});
else if(m.method==='tools/list')send({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'memnox_selftest_delete'}]}});
else if(m.id!==undefined)send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'REACHED THE SERVER'}]}});
}});
`;

export interface ProbeContext {
  home: string;
  /** Where the reader is standing, for the git-hook probe. */
  dir: string;
}

/**
 * Every seam, asked to refuse. Ordered so the two that carry most of an agent's reach
 * come first, because a reader who stops after two lines has read the important ones.
 */
export async function proveEnforcement(context: ProbeContext): Promise<SeamProof[]> {
  const sandbox = await mkdtemp(join(tmpdir(), 'memnox-selftest-'));
  const rules = join(sandbox, 'memnox.policies.toml');
  await writeFile(rules, PROBE_RULES, 'utf8');

  /* A sandbox home holding a registry, and no `MEMNOX_POLICIES` in the environment.
     That is how an agent runs: an editor started from a dock icon carries no
     environment, and a probe that sets the variable proves the seam *can* refuse
     rather than that it *will* — which is precisely the gap that once let `mcp wrap`
     report every server routed while the proxy came up with no rules at all. */
  await mkdir(join(sandbox, MEMNOX_HOME), { recursive: true, mode: 0o700 });
  await writeFile(
    join(sandbox, MEMNOX_HOME, 'policies.json'),
    `${JSON.stringify({ files: [rules] }, null, 2)}\n`,
    'utf8',
  );

  return [
    await proveMcp(sandbox),
    await proveShell(context.home, sandbox),
    proveGitHook(context.dir),
    proveOsGuard(context.home),
    proveEgress(),
  ];
}

/**
 * Drive the proxy exactly as an agent does: initialize, then call the forbidden tool.
 *
 * The upstream answers with a phrase nothing else prints, so "it was refused" and "it
 * reached the server" are told apart by what came back rather than by an exit code the
 * proxy has no reason to set.
 */
async function proveMcp(sandbox: string): Promise<SeamProof> {
  const seam = SURFACE_KIND.MCP;
  const stub = join(sandbox, 'stub.mjs');
  await writeFile(stub, STUB_SERVER, 'utf8');

  const call =
    `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"memnox-self-test","version":"1"}}}\n` +
    `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"memnox_selftest_delete","arguments":{}}}\n`;

  try {
    /* Spawned rather than piped through a shell: `printf '%s'` does not expand `\n`,
       so the two messages arrived on one line and the proxy could not read either.
       Writing to stdin has no quoting in it to get wrong. */
    const stdout = await speak(
      PROXY_BINARY,
      ['--name', 'memnox-selftest', '--', process.execPath, stub],
      call,
      resolvedThrough(sandbox),
    );

    if (stdout.includes('Denied by Memnox')) {
      return {
        seam,
        state: PROOF.ENFORCED,
        detail: 'a forbidden tools/call was refused',
      };
    }
    if (stdout.includes('REACHED THE SERVER')) {
      return {
        seam,
        state: PROOF.NOT_ENFORCED,
        detail: 'a forbidden tools/call reached the server',
        next: 'memnox doctor --wiring',
      };
    }
    return {
      seam,
      state: PROOF.UNPROVEN,
      detail: 'the proxy answered with neither a refusal nor the server’s reply',
    };
  } catch {
    // Not installed, or it would not start. Either way nothing was proved.
    return {
      seam,
      state: PROOF.ABSENT,
      detail: `${PROXY_BINARY} is not on PATH, so nothing stands in front of a tool call`,
      next: 'npm install -g memnox, then memnox mcp wrap',
    };
  }
}

/**
 * The environment an agent actually has: the sandbox as `HOME`, and no policy variable.
 *
 * Deleting it rather than leaving it unset matters — the reader may have exported one,
 * and inheriting it would let the probe pass on a machine where the seam only works
 * because that shell happened to carry it.
 */
function resolvedThrough(sandbox: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: sandbox };
  delete env['MEMNOX_POLICIES'];
  return env;
}

/**
 * Writes one burst to a child's stdin and returns everything it said.
 *
 * Resolves on exit rather than on a matching line, because the interesting failure is
 * a seam that answers nothing at all, and a reader waiting for a line that never comes
 * would hang instead of reporting it.
 */
function speak(
  command: string,
  args: readonly string[],
  input: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', () => resolve(out));
    const timer = setTimeout(() => child.kill(), PROBE_MS);
    timer.unref();
    child.stdin.end(input);
  });
}

/**
 * The shim, asked to run something the rule forbids.
 *
 * `git push --force` is used because it is a real action with a real verb table entry.
 * It runs inside a scratch directory with no remote, so if the seam is not enforcing
 * the command fails on its own rather than doing anything.
 */
async function proveShell(home: string, sandbox: string): Promise<SeamProof> {
  const seam = SURFACE_KIND.SHELL;
  const binary = join(interceptorDirFor(home), 'git');
  if (!existsSync(binary)) {
    return {
      seam,
      state: PROOF.ABSENT,
      detail: 'no interceptors installed, so every command runs unseen',
      next: 'memnox protect --interceptors',
    };
  }

  try {
    const { stdout, stderr } = await run(binary, ['push', '--force', 'origin', 'main'], {
      timeout: PROBE_MS,
      cwd: sandbox,
      env: { ...resolvedThrough(sandbox), MEMNOX_INTERCEPT: INTERCEPT_BINARY },
    });
    return refusedIn(seam, `${stdout}${stderr}`);
  } catch (err) {
    // A refusal exits non-zero, so the denial arrives here rather than above.
    const failure = err as { stdout?: string; stderr?: string };
    return refusedIn(seam, `${failure.stdout ?? ''}${failure.stderr ?? ''}`);
  }
}

function refusedIn(seam: SeamProof['seam'], output: string): SeamProof {
  if (output.includes('Denied by Memnox')) {
    return { seam, state: PROOF.ENFORCED, detail: 'a forbidden command was refused' };
  }
  return {
    seam,
    state: PROOF.NOT_ENFORCED,
    detail: 'a forbidden command was not refused',
    next: 'memnox doctor --wiring',
  };
}

/** A hook is a file in the repository, so its presence is the whole of the claim. */
function proveGitHook(dir: string): SeamProof {
  const hook = join(dir, '.git', 'hooks', 'pre-push');
  const seam = SURFACE_KIND.GIT;
  if (!existsSync(hook)) {
    return {
      seam,
      state: PROOF.ABSENT,
      detail: 'no hook here, so only the PATH wrapper is in front of git',
      next: 'memnox protect --hooks',
    };
  }
  /* Running it for real would need a remote and a push, so this says installed and
     stops short of calling it proved. Counting it as a pass would be the exact
     overstatement this command exists to catch. */
  return {
    seam,
    state: PROOF.UNPROVEN,
    detail: 'a hook is installed; proving it needs a real push',
  };
}

function proveOsGuard(home: string): SeamProof {
  const seam = SURFACE_KIND.FILESYSTEM;
  if (!existsSync(guardProfilePath(home))) {
    return {
      seam,
      state: PROOF.ABSENT,
      detail: 'no kernel profile, so a raw binary is not stopped',
      next: 'memnox protect --os-guard',
    };
  }
  return {
    seam,
    state: PROOF.UNPROVEN,
    detail: 'a profile is written; it binds only to what "memnox run" starts',
  };
}

/** Proxy variables are the whole mechanism, so their absence is the whole answer. */
function proveEgress(): SeamProof {
  const set = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'].some(
    (name) => (process.env[name] ?? '') !== '',
  );
  return set
    ? {
        seam: SURFACE_KIND.NETWORK,
        state: PROOF.UNPROVEN,
        detail: 'a proxy is set here; proving it needs a request',
      }
    : {
        seam: SURFACE_KIND.NETWORK,
        state: PROOF.ABSENT,
        detail: 'nothing observes outbound traffic from this shell',
        next: 'memnox run -- <agent>',
      };
}
