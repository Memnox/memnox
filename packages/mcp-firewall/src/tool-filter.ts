/**
 * Static allow/deny regexes over tool names — deny wins over allow.
 * Enforced at BOTH tools/list (hide) and tools/call (block): a client can
 * call a tool it was never shown, so filtering the listing alone is not a gate.
 */
export class ToolFilter {
  private readonly allow: RegExp | null;
  private readonly deny: RegExp | null;

  constructor(
    allowPattern?: string,
    denyPattern?: string,
    onInvalid?: (msg: string) => void,
  ) {
    this.allow = compilePattern(allowPattern, onInvalid);
    this.deny = compilePattern(denyPattern, onInvalid);
  }

  isAllowed(toolName: string): boolean {
    if (this.allow && !this.allow.test(toolName)) return false;
    if (this.deny && this.deny.test(toolName)) return false;
    return true;
  }
}

function compilePattern(
  pattern: string | undefined,
  onInvalid?: (msg: string) => void,
): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern);
  } catch (err) {
    // An unusable filter must not crash the proxy — report and ignore it.
    if (onInvalid) onInvalid(`invalid tool filter pattern "${pattern}": ${String(err)}`);
    return null;
  }
}
