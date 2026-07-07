/**
 * BYOK LLM port. Providers are interchangeable and optional — the runtime
 * never calls an LLM to decide; intelligence only drafts and explains.
 */
export interface LlmCompletionRequest {
  system?: string;
  prompt: string;
  maxTokens: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmCompletionResult {
  text: string;
  /** Absent when the provider cannot report token usage. */
  usage?: LlmUsage;
}

export interface LlmProvider {
  readonly name: string;
  complete(request: LlmCompletionRequest): Promise<string>;
  /** Providers that report token usage implement this; metering wrappers prefer it. */
  completeDetailed?(request: LlmCompletionRequest): Promise<LlmCompletionResult>;
}
