import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MCP_CLIENT = {
  CLAUDE_CODE: 'claude-code',
  CURSOR: 'cursor',
} as const;

export const SUPPORTED_MCP_CLIENTS: readonly string[] = Object.values(MCP_CLIENT);

/** The server entry every client gets. Absolute paths: a GUI client inherits no PATH. */
export const MEMNOX_SERVER_KEY = 'memnox';

interface McpServerEntry {
  type: 'stdio';
  command: string;
  args: string[];
}

function memnoxServerEntry(): McpServerEntry {
  return {
    type: 'stdio',
    command: process.execPath,
    args: [fileURLToPath(import.meta.url), 'mcp'],
  };
}

interface McpInstallReport {
  client: string;
  path: string;
  installed: boolean;
}

/** User-level, never project-level: a committed MCP config would hijack a teammate's. */
export class McpInstaller {
  constructor(private readonly homeDir: string) {}

  get claudePath(): string {
    return join(this.homeDir, '.claude.json');
  }

  get cursorPath(): string {
    return join(this.homeDir, '.cursor', 'mcp.json');
  }

  pathFor(client: string): string {
    if (client === MCP_CLIENT.CLAUDE_CODE) return this.claudePath;
    if (client === MCP_CLIENT.CURSOR) return this.cursorPath;
    throw new Error(
      `unsupported MCP client "${client}" — expected one of: ${SUPPORTED_MCP_CLIENTS.join(', ')}`,
    );
  }

  async install(client: string): Promise<McpInstallReport> {
    const path = this.pathFor(client);
    const config = await readJson(path);
    const servers = asRecord(config['mcpServers']);

    // Never overwrite: an existing entry may point somewhere deliberate.
    if (servers[MEMNOX_SERVER_KEY] !== undefined) {
      return { client, path, installed: false };
    }

    servers[MEMNOX_SERVER_KEY] = memnoxServerEntry();
    config['mcpServers'] = servers;
    await writeJson(path, config);
    return { client, path, installed: true };
  }

  /** A config file in $HOME is the only signal available without launching the client. */
  async installDetected(): Promise<McpInstallReport[]> {
    const reports: McpInstallReport[] = [];
    if (existsSync(this.claudePath) || existsSync(join(this.homeDir, '.claude'))) {
      reports.push(await this.install(MCP_CLIENT.CLAUDE_CODE));
    }
    if (existsSync(join(this.homeDir, '.cursor'))) {
      reports.push(await this.install(MCP_CLIENT.CURSOR));
    }
    return reports;
  }

  async uninstall(client: string): Promise<boolean> {
    const path = this.pathFor(client);
    const config = await readJson(path);
    const servers = asRecord(config['mcpServers']);
    if (servers[MEMNOX_SERVER_KEY] === undefined) return false;

    delete servers[MEMNOX_SERVER_KEY];
    config['mcpServers'] = servers;
    await writeJson(path, config);
    return true;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return {};
  return value as Record<string, unknown>;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return {}; // First install, or a config this client has not written yet.
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
