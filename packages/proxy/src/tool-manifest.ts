/**
 * What the wrapped server said about each tool when it listed them, kept for the life of
 * the proxy, so a call is classified by the server's own hints rather than by its name.
 */
import type { McpToolDeclaration } from '@memnox/core';

export class ToolManifest {
  private readonly declared = new Map<string, McpToolDeclaration>();

  /** The latest listing replaces the last, since a server may change what it holds. */
  listed(tools: readonly McpToolDeclaration[]): void {
    this.declared.clear();
    for (const tool of tools) this.declared.set(tool.name, tool);
  }

  /** Absent before the first listing, or for a tool the server never listed. */
  declaration(name: string): McpToolDeclaration | undefined {
    return this.declared.get(name);
  }
}
