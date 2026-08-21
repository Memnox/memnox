import {
  AnthropicProvider,
  OpenAiProvider,
  type LlmProvider,
} from '@memnox/intelligence';

const PROVIDER_ANTHROPIC = 'anthropic';
const PROVIDER_OPENAI = 'openai';
const ENV_OPENAI_API_KEY = 'OPENAI_API_KEY';
const ENV_ANTHROPIC_API_KEY = 'ANTHROPIC_API_KEY';
/** The SDK accepts either; a user who set the token should not be told to set the key. */
const ENV_ANTHROPIC_AUTH_TOKEN = 'ANTHROPIC_AUTH_TOKEN';

/** A missing key is a setup step, not a failure — no BYOK command decides anything. */
function missingKey(variable: string, provider: string): Error {
  return new Error(
    `${variable} is required for the ${provider} provider.\n` +
      `This command calls an LLM to draft or explain; it never decides anything.\n` +
      `Set ${variable}, or pass --provider to use a different one.`,
  );
}

export const PROVIDER_CHOICES: readonly string[] = [PROVIDER_ANTHROPIC, PROVIDER_OPENAI];

/** How a BYOK command obtains its provider. Injected so tests never reach a network. */
export type LlmProviderFactory = (provider: string, model?: string) => LlmProvider;

/** Shared --provider/--model handling for every BYOK CLI command. */
export const buildLlmProvider: LlmProviderFactory = (provider, model) => {
  if (provider === PROVIDER_OPENAI) {
    const apiKey = process.env[ENV_OPENAI_API_KEY];
    if (!apiKey) throw missingKey(ENV_OPENAI_API_KEY, PROVIDER_OPENAI);
    return new OpenAiProvider(apiKey, model);
  }
  // The SDK defers this to the first call, which surfaces as a stack trace
  // several commands deep instead of a missing-key message here.
  if (!process.env[ENV_ANTHROPIC_API_KEY] && !process.env[ENV_ANTHROPIC_AUTH_TOKEN]) {
    throw missingKey(ENV_ANTHROPIC_API_KEY, PROVIDER_ANTHROPIC);
  }
  return new AnthropicProvider({ model });
};
