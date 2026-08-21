/** Inference providers the proxy knows how to reach and how to read. */
const UPSTREAM = {
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
} as const;

type UpstreamName = (typeof UPSTREAM)[keyof typeof UPSTREAM];

export const UPSTREAM_NAMES: readonly string[] = Object.values(UPSTREAM);

export function isUpstreamName(value: unknown): value is UpstreamName {
  return typeof value === 'string' && UPSTREAM_NAMES.includes(value);
}

/** The action every proxied call is decided under. */
export const INFERENCE_ACTION = 'llm.infer';

export const UPSTREAM_KEY_HEADER = 'x-upstream-api-key';

interface UpstreamSpec {
  baseUrl: string;
  /** Carries the caller's own key upstream — this proxy never holds one. */
  auth: (key: string) => Record<string, string>;
}

const SPECS: Record<UpstreamName, UpstreamSpec> = {
  [UPSTREAM.OPENAI]: {
    baseUrl: 'https://api.openai.com',
    auth: (key) => ({ authorization: `Bearer ${key}` }),
  },
  [UPSTREAM.ANTHROPIC]: {
    baseUrl: 'https://api.anthropic.com',
    auth: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
  },
};

export function upstreamUrl(name: UpstreamName, path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${SPECS[name].baseUrl}${suffix}`;
}

export function upstreamAuth(name: UpstreamName, key: string): Record<string, string> {
  return SPECS[name].auth(key);
}

/** Both providers name the model at the top level of the request body. */
export function modelFromBody(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const model = (body as { model?: unknown }).model;
  return typeof model === 'string' && model.length > 0 ? model : undefined;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Absent usage means zero, never a guess: a spend cap must not act on invention. */
export function usageFromResponse(body: unknown): TokenUsage {
  if (typeof body !== 'object' || body === null) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  const usage = (body as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  const record = usage as Record<string, unknown>;
  return {
    inputTokens: numberAt(record, 'prompt_tokens', 'input_tokens'),
    outputTokens: numberAt(record, 'completion_tokens', 'output_tokens'),
  };
}

function numberAt(record: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return 0;
}
