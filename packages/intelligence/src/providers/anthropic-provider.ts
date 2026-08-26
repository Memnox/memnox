import Anthropic from '@anthropic-ai/sdk';
import type {
  LlmCompletionRequest,
  LlmCompletionResult,
  LlmProvider,
} from '../llm-provider';
import { REASONING_LEVEL, thinkingBudgetFor, type ReasoningLevel } from '../reasoning';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';
const FALLBACK_BETA = 'server-side-fallback-2026-06-01';
const FALLBACK_MODEL = 'claude-opus-4-8';

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  private readonly reasoning: ReasoningLevel;

  constructor(
    options: { apiKey?: string; model?: string; reasoning?: ReasoningLevel } = {},
    private readonly model: string = options.model ?? DEFAULT_ANTHROPIC_MODEL,
  ) {
    this.client = new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
    this.reasoning = options.reasoning ?? REASONING_LEVEL.NONE;
  }

  async complete(request: LlmCompletionRequest): Promise<string> {
    return (await this.completeDetailed(request)).text;
  }

  async completeDetailed(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    // Undefined when thinking is off, or when maxTokens leaves no room for it.
    const budget = thinkingBudgetFor(this.reasoning, request.maxTokens);
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: request.maxTokens,
      system: request.system,
      ...(budget === undefined
        ? {}
        : { thinking: { type: 'enabled' as const, budget_tokens: budget } }),
      // Safety classifiers can decline; the server retries on the fallback model.
      betas: [FALLBACK_BETA],
      fallbacks: [{ model: FALLBACK_MODEL }],
      messages: [{ role: 'user', content: request.prompt }],
    });
    if (response.stop_reason === 'refusal') {
      throw new Error('LLM provider declined the request');
    }
    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    return {
      text,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}
