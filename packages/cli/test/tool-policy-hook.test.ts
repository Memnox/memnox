import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DECISION_EFFECT,
  ENFORCEMENT_MODE,
  loadPolicySet,
  policiesFrom,
  readPolicyDocumentFile,
  readPolicyRegistry,
  recommendedAnswers,
  writePolicyDocumentFile,
} from '@memnox/core';
import { answerToolCall } from '@memnox/interceptors';
import { keepOnce, KEPT_CHANGE, type KeepSeams } from '../src/keeper/keep-boundary';
import { keepBoundary, markHook } from '../src/keeper/kept';
import { EDIT_HOOK_TARGETS, type EditHookTarget } from '../src/protect/agent-hooks';
import {
  EVERY_TOOL,
  installClaudeHook,
  removeClaudeHook,
} from '../src/protect/claude-hook';
import {
  machinePolicyPath,
  writeMachineRules,
  baselineRules,
} from '../src/protect/machine-rules';
import { policyFilesInForce, readRegisteredFiles } from '../src/policy-path';
import { policyRegistryPath } from '../src/policy-registry';
import { wireMachine, type WiringSeams } from '../src/setup-wiring';

/**
 * The secret rules lived in the repository setup ran in, so an agent working in any other
 * checkout, or in that one after somebody edited the file, read `~/.ssh` freely. And the
 * hook setup installed only took leases, so an agent's own Read tool met no rule at all.
 */

const machine = () => mkdtemp(join(tmpdir(), 'memnox-tool-policy-'));

/* Nothing real is installed: no wrappers, no service, no MCP rewrite, no agent hooks. */
const offline: WiringSeams = {
  interceptors: async () => ({ installed: [], absent: [], directory: '', pathLine: '' }),
  service: async () => ({
    state: { supported: false, installed: false, path: '', manager: 'none' },
  }),
  claudeHook: async () => false,
  codexHook: async () => false,
  cursorHook: async () => false,
  geminiHook: async () => false,
  windsurfHook: async () => false,
  mcp: async () => ({ wrapped: 0, skipped: false }),
  keep: async () => undefined,
};

function readSecret(cwd: string, home: string) {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    cwd,
    permission_mode: 'default',
    tool_name: 'Read',
    tool_input: { file_path: join(home, '.ssh', 'id_ed25519') },
  };
}

describe("the machine's own rules", () => {
  it('puts the secret rules in ~/.memnox, registered, and the rest in the project', async () => {
    const home = await machine();
    const project = await mkdtemp(join(tmpdir(), 'memnox-project-'));

    const wired = await wireMachine(home, project, offline);

    const machineRules = await readPolicyDocumentFile(machinePolicyPath(home));
    expect(machineRules?.policies.map((rule) => rule.name)).toEqual(['filesystem-deny']);
    const projectRules = await readPolicyDocumentFile(
      join(project, 'memnox.policies.toml'),
    );
    expect(projectRules?.policies.map((rule) => rule.name)).not.toContain(
      'filesystem-deny',
    );
    expect(await readRegisteredFiles(home)).toContain(machinePolicyPath(home));
    expect(wired.rules).toBe(policiesFrom(recommendedAnswers()).length);
  });

  it('counts each rule once, however many times setup runs', async () => {
    const home = await machine();
    const project = await mkdtemp(join(tmpdir(), 'memnox-project-'));
    await wireMachine(home, project, offline);
    await wireMachine(home, project, offline);

    const files = await readPolicyRegistry(policyRegistryPath(home));
    expect(files).toHaveLength(2);
    const set = await loadPolicySet(
      await policyFilesInForce(home, undefined, () => false),
    );
    expect(set.policies).toHaveLength(policiesFrom(recommendedAnswers()).length);
  });

  it('moves the rule an older setup wrote into the project, and keeps an edited one', async () => {
    const home = await machine();
    const project = await mkdtemp(join(tmpdir(), 'memnox-project-'));
    const path = join(project, 'memnox.policies.toml');
    await writePolicyDocumentFile(path, {
      version: 1,
      policies: policiesFrom(recommendedAnswers()),
    });

    await wireMachine(home, project, offline);
    const moved = await readPolicyDocumentFile(path);
    expect(moved?.policies.map((rule) => rule.name)).not.toContain('filesystem-deny');

    const [secret] = baselineRules().machine;
    if (secret === undefined) throw new Error('the baseline has a secret rule');
    const edited = { ...secret, match: { ...secret.match, targets: ['**/.netrc'] } };
    await writePolicyDocumentFile(path, { version: 1, policies: [edited] });
    await wireMachine(home, project, offline);
    const kept = await readPolicyDocumentFile(path);
    expect(kept?.policies.map((rule) => rule.name)).toContain('filesystem-deny');
  });

  it('denies a secret read in a repository where setup never ran', async () => {
    const home = await machine();
    const elsewhere = await mkdtemp(join(tmpdir(), 'memnox-never-set-up-'));
    await writeMachineRules(home, baselineRules().machine);

    const answer = await answerToolCall(
      readSecret(elsewhere, home),
      {
        home,
        agent: 'claude-code',
        runSession: undefined,
        env: {},
        personThere: true,
        now: () => new Date(),
      },
      { mode: ENFORCEMENT_MODE.ENFORCE, sink: null },
    );

    expect(answer?.ruling).toMatchObject({
      effect: DECISION_EFFECT.DENY,
      rule: 'filesystem-deny',
    });
    expect(answer?.reply?.stdout).toContain('"permissionDecision":"deny"');
  });
});

describe('the hook every agent runs rules on every tool call', () => {
  const claude = (home: string) => join(home, '.claude', 'settings.json');
  const onlyClaude: KeepSeams = {
    targets: [
      {
        name: 'Claude Code',
        file: join('.claude', 'settings.json'),
        agent: 'claude-code',
        install: installClaudeHook,
        remove: removeClaudeHook,
      } satisfies EditHookTarget,
    ],
    wrap: async () => ({ names: [] }),
    projects: () => [],
  };

  it('installs a PreToolUse hook for every tool, and uninstall takes it out', async () => {
    const home = await machine();
    await mkdir(join(home, '.claude'));

    expect(await installClaudeHook(home)).toBe(true);
    const settings = JSON.parse(await readFile(claude(home), 'utf8')) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
    };
    const [before] = settings.hooks['PreToolUse'] ?? [];
    expect(before?.matcher).toBe(EVERY_TOOL);
    expect(before?.hooks[0]?.command).toContain('--policy');

    expect(await removeClaudeHook(home)).toBe(true);
    expect(await readFile(claude(home), 'utf8')).not.toContain('memnox-edit-hook');
  });

  it('upgrades a hook an older setup wrote for leases only', async () => {
    const home = await machine();
    await mkdir(join(home, '.claude'));
    await keepBoundary(home, ['Claude Code']);
    const leasesOnly = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Write|Edit',
            hooks: [{ type: 'command', command: 'memnox-edit-hook' }],
          },
        ],
      },
    };
    await writeFile(claude(home), JSON.stringify(leasesOnly));

    const changes = await keepOnce(home, onlyClaude);

    expect(changes).toEqual([{ kind: KEPT_CHANGE.UPGRADED, agent: 'Claude Code' }]);
    expect(await readFile(claude(home), 'utf8')).toContain('--policy');
    expect(await keepOnce(home, onlyClaude)).toEqual([]);
  });

  /* A policy hook from before SessionStart existed counted as current, so a machine set up
     then never heard the boundary at the start of a session until setup ran again. */
  it('upgrades a policy hook that lacks the session start the boundary rides on', async () => {
    const home = await machine();
    await mkdir(join(home, '.claude'));
    await keepBoundary(home, ['Claude Code']);
    const beforeSessionStart = {
      hooks: {
        PreToolUse: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'memnox-edit-hook --policy' }],
          },
        ],
      },
    };
    await writeFile(claude(home), JSON.stringify(beforeSessionStart));
    const claudeTarget = EDIT_HOOK_TARGETS.filter((each) => each.name === 'Claude Code');

    const changes = await keepOnce(home, { ...onlyClaude, targets: claudeTarget });

    expect(changes).toEqual([{ kind: KEPT_CHANGE.UPGRADED, agent: 'Claude Code' }]);
    expect(await readFile(claude(home), 'utf8')).toContain('"SessionStart"');
    expect(await keepOnce(home, { ...onlyClaude, targets: claudeTarget })).toEqual([]);
  });

  it('puts a removed hook back, and leaves one taken out on purpose out', async () => {
    const home = await machine();
    await mkdir(join(home, '.claude'));
    await keepBoundary(home, ['Claude Code']);
    await writeFile(claude(home), '{}');

    expect(await keepOnce(home, onlyClaude)).toEqual([
      { kind: KEPT_CHANGE.RESTORED, agent: 'Claude Code' },
    ]);

    await removeClaudeHook(home);
    await markHook(home, 'Claude Code', false);
    expect(await keepOnce(home, onlyClaude)).toEqual([]);
    expect(await readFile(claude(home), 'utf8')).not.toContain('memnox-edit-hook');
  });
});
