import { parse, stringify } from 'yaml';
import type { PolicyDocument } from '@memnox/policy-engine';
import { POLICY_DOCUMENT_VERSION, validatePolicyDocument } from '@memnox/policy-engine';
import type { LlmProvider } from './llm-provider';

const DRAFT_MAX_TOKENS = 8_192;

const DRAFT_SYSTEM_PROMPT = `You translate natural-language governance rules into Memnox policy YAML.
Output ONLY a YAML document, no prose, with this shape:

version: ${POLICY_DOCUMENT_VERSION}
policies:
  - name: kebab-case-name
    description: one line
    match:
      actions: ["namespace.verb", ...]   # wildcards allowed, e.g. "database.*"
      targets: ["pattern", ...]          # optional
      environments: ["production", ...]  # optional
      agents: ["agent-name", ...]        # optional
    decision:
      effect: allow | block | require_approval
      reason: one line                   # optional
      approvers: ["team-name", ...]      # required when effect is require_approval`;

export interface PolicyDraft {
  document: PolicyDocument;
  yaml: string;
}

/**
 * Drafts policies from plain language. The draft is validated by the same
 * deterministic validator that guards the runtime — a human still reviews
 * and commits the file; the LLM never touches enforcement.
 */
export class PolicyDrafter {
  constructor(private readonly provider: LlmProvider) {}

  async draft(instruction: string): Promise<PolicyDraft> {
    const raw = await this.provider.complete({
      system: DRAFT_SYSTEM_PROMPT,
      prompt: instruction,
      maxTokens: DRAFT_MAX_TOKENS,
    });
    const document = validatePolicyDocument(parse(stripFences(raw)));
    return { document, yaml: stringify(document) };
  }
}

function stripFences(content: string): string {
  return content.replace(/```(?:yaml|yml)?|```/g, '').trim();
}
