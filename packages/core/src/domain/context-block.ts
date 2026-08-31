import {
  AUTHORITATIVE_TRUST,
  CONTEXT_TRUST,
  type ContextTrust,
} from '../constants/context-trust.constants';

/** The block that makes injection a data model problem rather than a detector problem. */
export interface ContextBlock {
  /** Where it came from: "README.md", "mcp:github/get_issue". */
  source: string;
  trust: ContextTrust;
  content: string;
}

export interface ContextRef {
  source: string;
  trust: ContextTrust;
}

export function isContextTrust(value: unknown): value is ContextTrust {
  return (
    typeof value === 'string' &&
    (Object.values(CONTEXT_TRUST) as string[]).includes(value)
  );
}

/** Data cannot become authority because an agent read it. */
export function carriesAuthority(block: ContextBlock): boolean {
  return AUTHORITATIVE_TRUST.includes(block.trust);
}

/**
 * Untrusted blocks survive as evidence and lose their instruction authority. They are
 * never dropped: a rule may still match on what an agent was told, and a stripped block
 * that vanished would leave the explanation unable to say why.
 */
export function stripInstructionAuthority(blocks: readonly ContextBlock[]): {
  authoritative: ContextBlock[];
  evidence: ContextBlock[];
} {
  const authoritative: ContextBlock[] = [];
  const evidence: ContextBlock[] = [];
  for (const block of blocks) {
    if (carriesAuthority(block)) authoritative.push(block);
    else evidence.push(block);
  }
  return { authoritative, evidence };
}

export function contextRefOf(block: ContextBlock): ContextRef {
  return { source: block.source, trust: block.trust };
}
