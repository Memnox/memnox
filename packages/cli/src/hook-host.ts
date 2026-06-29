/**
 * Everything the editor hands the hook process: the tool call on stdin, the two
 * output streams, the exit code, and the configuring environment. Injected as
 * one port because a hook is defined by this contract with its host.
 */
export interface HookHost {
  readInput(): Promise<string | null>;
  /** stdout — Cursor reads the verdict as JSON here. */
  respond(payload: string): void;
  /** stderr — Claude Code reads the denial reason here. */
  warn(message: string): void;
  exit(code: number): never;
  env(name: string): string | undefined;
}

export const processHookHost: HookHost = {
  async readInput() {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    } catch {
      return null; // Unreadable hook input — the caller fails open.
    }
  },
  respond(payload) {
    process.stdout.write(payload);
  },
  warn(message) {
    process.stderr.write(`${message}\n`);
  },
  exit(code) {
    process.exit(code);
  },
  env(name) {
    return process.env[name];
  },
};
