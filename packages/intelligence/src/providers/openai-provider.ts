import type {
  LlmCompletionRequest,
  LlmCompletionResult,
  LlmProvider,
} from '../llm-provider';

export const DEFAULT_OPENAI_MODEL = 'gpt-4o';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

/** The completion text, or empty when the response carries no usable choice. */
function firstChoiceText(choices?: Array<{ message?: { content?: string } }>): string {
  if (choices === undefined) return '';
  const first = choices[0];
  if (first === undefined || first.message === undefined) return '';
  return first.message.content ?? '';
}

export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';

  constructor(
    private readonly apiKey: string,
    private readonly model: string = DEFAULT_OPENAI_MODEL,
  ) {}

  async complete(request: LlmCompletionRequest): Promise<string> {
    return (await this.completeDetailed(request)).text;
  }

  async completeDetailed(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    const messages: Array<{ role: string; content: string }> = [];
    if (request.system) messages.push({ role: 'system', content: request.system });
    messages.push({ role: 'user', content: request.prompt });

    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_completion_tokens: request.maxTokens,
        messages,
      }),
    });
    if (!response.ok) {
      throw new Error(`OpenAI request failed with status ${response.status}`);
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: firstChoiceText(data.choices),
      usage: data.usage
        ? {
            inputTokens: data.usage.prompt_tokens ?? 0,
            outputTokens: data.usage.completion_tokens ?? 0,
          }
        : undefined,
    };
  }
}
