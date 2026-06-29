import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CURSOR_AFTER_FILE_EDIT,
  CURSOR_BLOCKING_EVENTS,
  CURSOR_HOOKS_VERSION,
  CURSOR_HOOK_TIMEOUT_S,
} from './cursor-hook-mapping';
import { HOOK_MATCHER, HOOK_TIMEOUT_S } from './hook-mapping';
import { HOOK_AGENT, SUPPORTED_HOOK_AGENTS } from './commands/hook.command';

const CURSOR_GOVERNED_EVENTS: readonly string[] = [
  CURSOR_BLOCKING_EVENTS.PRE_TOOL_USE,
  CURSOR_BLOCKING_EVENTS.BEFORE_SHELL,
  CURSOR_BLOCKING_EVENTS.BEFORE_MCP,
  CURSOR_AFTER_FILE_EDIT,
];

interface ClaudeHookEntry {
  type: 'command';
  command: string;
  timeout: number;
}

interface ClaudeMatcherGroup {
  matcher?: string;
  hooks?: ClaudeHookEntry[];
}

interface CursorHookEntry {
  command?: string;
  timeout?: number;
}

interface InstallReport {
  agent: string;
  path: string;
  installed: boolean;
}

/**
 * Writes the hook into an editor's user-level config. User-level and never
 * project-level: a committed hooks file would hand every clone of the repo an
 * enforcement config it did not choose.
 *
 * Takes the home directory rather than reading it, so tests install into a
 * scratch directory and assert on the JSON that lands there.
 */
export class EditorHookInstaller {
  constructor(
    private readonly homeDir: string,
    private readonly hookCommandFor: (agent: string) => string,
  ) {}

  get claudeSettingsPath(): string {
    return join(this.homeDir, '.claude', 'settings.json');
  }

  get cursorHooksPath(): string {
    return join(this.homeDir, '.cursor', 'hooks.json');
  }

  async install(agent: string): Promise<InstallReport> {
    if (agent === HOOK_AGENT.CLAUDE_CODE) {
      return {
        agent,
        path: this.claudeSettingsPath,
        installed: await this.installClaudeCode(),
      };
    }
    if (agent === HOOK_AGENT.CURSOR) {
      return {
        agent,
        path: this.cursorHooksPath,
        installed: await this.installCursor(),
      };
    }
    throw new Error(
      `unsupported agent "${agent}" — expected one of: ${SUPPORTED_HOOK_AGENTS.join(', ')}`,
    );
  }

  /** A config directory in $HOME is the only signal available without launching the editor. */
  async installDetected(): Promise<InstallReport[]> {
    const detected: string[] = [];
    if (existsSync(join(this.homeDir, '.claude'))) detected.push(HOOK_AGENT.CLAUDE_CODE);
    if (existsSync(join(this.homeDir, '.cursor'))) detected.push(HOOK_AGENT.CURSOR);

    const reports: InstallReport[] = [];
    for (const agent of detected) reports.push(await this.install(agent));
    return reports;
  }

  private async installClaudeCode(): Promise<boolean> {
    const command = this.hookCommandFor(HOOK_AGENT.CLAUDE_CODE);
    const settings = await readJson(this.claudeSettingsPath);
    const hooks = (settings['hooks'] ?? {}) as Record<string, unknown>;
    const preToolUse = (
      Array.isArray(hooks['PreToolUse']) ? hooks['PreToolUse'] : []
    ) as ClaudeMatcherGroup[];

    const alreadyInstalled = preToolUse.some((group) => {
      if (group.hooks === undefined) return false;
      return group.hooks.some((hook) =>
        hook.command.endsWith(`hook ${HOOK_AGENT.CLAUDE_CODE}`),
      );
    });
    if (alreadyInstalled) return false;

    preToolUse.push({
      matcher: HOOK_MATCHER,
      hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }],
    });
    hooks['PreToolUse'] = preToolUse;
    settings['hooks'] = hooks;
    await writeJson(this.claudeSettingsPath, settings);
    return true;
  }

  private async installCursor(): Promise<boolean> {
    const command = this.hookCommandFor(HOOK_AGENT.CURSOR);
    const config = await readJson(this.cursorHooksPath);
    const hooks = (config['hooks'] ?? {}) as Record<string, unknown>;

    let changed = false;
    for (const event of CURSOR_GOVERNED_EVENTS) {
      const entries = (
        Array.isArray(hooks[event]) ? hooks[event] : []
      ) as CursorHookEntry[];
      const present = entries.some((entry) => {
        if (entry.command === undefined) return false;
        return entry.command.endsWith(`hook ${HOOK_AGENT.CURSOR}`);
      });
      if (present) continue;
      entries.push({ command, timeout: CURSOR_HOOK_TIMEOUT_S });
      hooks[event] = entries;
      changed = true;
    }
    if (!changed) return false;

    config['version'] = CURSOR_HOOKS_VERSION;
    config['hooks'] = hooks;
    await writeJson(this.cursorHooksPath, config);
    return true;
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return {}; // First install — no config file yet.
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
