import type { TaskRef } from './task';

/** The core primitive: every AI action becomes an event Memnox can rule on and prove. */
export interface ActionRequest {
  /** Namespaced verb, e.g. "database.delete", "code.modify", "deploy.service". */
  action: string;
  /** What the action operates on, e.g. "production.users", "payment/checkout.ts". */
  target?: string;
  environment?: string;
  /** Groups actions into one agent session for replay and reporting. */
  sessionId?: string;
  /** The governance unit, declared in a policy file — repos sharing a name share one scope. */
  projectId?: string;
  /** Whose authority the agent draws on — not who the agent is, which is its credential. */
  principal?: string;
  /** Facts this action relies on, so "may not do" is tellable from "should not know". */
  reads?: readonly string[];
  /** What was actually asked for. Declared by the client; never inferred here. */
  task?: TaskRef;
  /** The agent's stated intent — recorded verbatim for the audit trail. */
  reason?: string;
  metadata?: Record<string, unknown>;
  /** Reference to a previously granted approval for this same action. */
  approvalId?: string;
  /** Model behind the action, e.g. "openai.gpt-4". Reported by the caller. */
  model?: string;
  /** Inference provider, e.g. "openai", "anthropic", "bedrock". */
  provider?: string;
  /** What kind of regulated data this touches, e.g. "pii.eu", "hipaa", "pci". */
  dataClassification?: string;
  /** Region the action executes in, e.g. "eu", "us". */
  jurisdiction?: string;
  /** How big the action is; size is often the whole rule. Read by `aboveAmount`. */
  amount?: number;
  /** Directory the agent is working in, e.g. "/srv/checkout". Reported by the caller. */
  workingDirectory?: string;
  /** Source control branch the work sits on, e.g. "main", "release/24.3". */
  branch?: string;
  /** LOCAL ONLY: the raw payload. The SDK strips it; `signals` travel instead. */
  arguments?: Record<string, string>;
  /** What the local gate found. Testimony: it may ask, never loosen. */
  signals?: string[];
}
