import type { McpToolDeclaration } from './surface';

/**
 * Discovery reaches for the filesystem constantly, so the filesystem is an argument.
 * Every detector is then a pure function of what the machine says it holds.
 */
export interface MachineReader {
  /** True when the path exists. Never throws: an unreadable path is simply absent. */
  exists(path: string): Promise<boolean>;
  /** The file's text, or null when it cannot be read. */
  read(path: string): Promise<string | null>;
  /** Immediate children of a directory, empty when it cannot be listed. */
  list(path: string): Promise<string[]>;
  homeDir(): string;
  /** The operating-system user, which is the owner hint until a person confirms it. */
  userName(): string;
}

/**
 * MCP servers are enumerated over the protocol rather than guessed from a config,
 * because a config says what a server is called and not what it can do.
 */
export interface McpLister {
  listTools(
    server: string,
    command: string,
    args: readonly string[],
  ): Promise<McpToolDeclaration[]>;
}

/** A step that changes the machine states its inverse before it runs. */
export interface HardenWriter {
  write(path: string, contents: string): Promise<void>;
  remove(path: string): Promise<void>;
  read(path: string): Promise<string | null>;
}
