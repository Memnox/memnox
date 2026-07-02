import {
  AnthropicProvider,
  OpenAiProvider,
  type LlmProvider,
} from '@memnox/intelligence';

const PROVIDER_ANTHROPIC = 'anthropic';
const PROVIDER_OPENAI = 'openai';
const ENV_OPENAI_API_KEY = 'OPENAI_API_KEY';

export const PROVIDER_CHOICES: readonly string[] = [PROVIDER_ANTHROPIC, PROVIDER_OPENAI];

/** How a BYOK command obtains its provider. Injected so tests never reach a network. */
export type LlmProviderFactory = (provider: string, model?: string) => LlmProvider;

/** Shared --provider/--model handling for every BYOK CLI command. */
export const buildLlmProvider: LlmProviderFactory = (provider, model) => {
  if (provider === PROVIDER_OPENAI) {
    const apiKey = process.env[ENV_OPENAI_API_KEY];
    if (!apiKey)
      throw new Error(`${ENV_OPENAI_API_KEY} is required for the openai provider`);
    return new OpenAiProvider(apiKey, model);
  }
  return new AnthropicProvider({ model });
};
