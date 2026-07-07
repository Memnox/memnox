const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
const DEFAULT_TIMEOUT_MS = 20_000;
/** Batch ceiling per request — well inside provider limits. */
const MAX_BATCH = 64;

/** BYOK, like the LLM port. Embeddings improve recall; they never decide anything. */
export interface EmbeddingProvider {
  readonly name: string;
  embed(texts: readonly string[]): Promise<number[][]>;
}

export interface OpenAiEmbeddingOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';

  constructor(private readonly options: OpenAiEmbeddingOptions) {}

  async embed(texts: readonly string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += MAX_BATCH) {
      vectors.push(...(await this.embedBatch(texts.slice(start, start + MAX_BATCH))));
    }
    return vectors;
  }

  private async embedBatch(batch: readonly string[]): Promise<number[][]> {
    if (batch.length === 0) return [];
    const send = this.options.fetchImpl ?? fetch;
    const response = await send(this.options.baseUrl ?? OPENAI_EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.options.model ?? DEFAULT_EMBEDDING_MODEL,
        input: batch,
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`embedding request failed: HTTP ${response.status}`);
    }

    const body = (await response.json()) as EmbeddingResponse;
    const ordered = [...(body.data ?? [])].sort(
      (a, b) => (a.index ?? 0) - (b.index ?? 0),
    );
    return ordered.map((entry) => entry.embedding ?? []);
  }
}
