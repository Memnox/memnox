import {
  STATED_KIND,
  candidateStatement,
  type Stated,
  type StatedKind,
} from '@memnox/org-graph';
import type { LlmProvider } from './llm-provider';

const EXTRACT_MAX_TOKENS = 4_096;
/** Nothing below this is worth a reviewer's attention; the model's own number. */
const MIN_CONFIDENCE = 0.4;
/** A bound on one run, so a noisy channel cannot produce a review queue nobody reads. */
const MAX_STATEMENTS_PER_RUN = 25;

const KINDS: readonly string[] = Object.values(STATED_KIND);

const EXTRACT_SYSTEM_PROMPT = `You read workplace conversations and report what the organization has stated about itself.

Output ONLY a JSON array. Each element:
{
  "kind": "decision" | "policy" | "authority" | "responsibility" | "relationship",
  "statement": "the claim in the company's own words, one sentence",
  "subject": "what it is about — a person, team, system, or topic",
  "principal": "the person it grants something to (authority only)",
  "capability": "comma-separated action patterns, e.g. payment.refund (authority only)",
  "limit": 10000,
  "object": "the other party (responsibility: the owner; relationship: the counterpart)",
  "confidence": 0.0 to 1.0,
  "evidence": ["message id", ...]
}

Rules:
- Report only what somebody actually stated. Never infer a policy from a habit.
- Quote the company's own words in "statement". Do not summarise into your own.
- Omit any field you cannot support from the text. Do not guess a limit.
- If the conversation states nothing about the organization, output [].`;

/** One message from a source, flattened to what an extractor needs to read it. */
export interface SourceMessage {
  id: string;
  author: string;
  occurredAt: string;
  text: string;
  /** Permalink back to the message, carried onto every statement read from it. */
  sourceRef?: string;
}

export interface ExtractionRequest {
  workspaceId: string;
  messages: readonly SourceMessage[];
  /** Ids for the statements produced. Injected so a run is reproducible. */
  newId: () => string;
  detectedAt: string;
}

/** The whole intelligence plane, deliberately on the far side of the decision path. */
export class OrganizationExtractor {
  constructor(private readonly provider: LlmProvider) {}

  async extract(request: ExtractionRequest): Promise<Stated[]> {
    if (request.messages.length === 0) return [];

    const raw = await this.provider.complete({
      system: EXTRACT_SYSTEM_PROMPT,
      prompt: renderMessages(request.messages),
      maxTokens: EXTRACT_MAX_TOKENS,
    });

    return parseStatements(raw)
      .filter(isUsable)
      .slice(0, MAX_STATEMENTS_PER_RUN)
      .map((entry) => this.toStated(entry, request));
  }

  private toStated(entry: UsableStatement, request: ExtractionRequest): Stated {
    const source = sourceOf(entry.evidence, request.messages);
    return candidateStatement({
      id: request.newId(),
      workspaceId: request.workspaceId,
      kind: entry.kind,
      statement: entry.statement,
      subject: entry.subject,
      ...(entry.principal === undefined ? {} : { principal: entry.principal }),
      ...(entry.capability === undefined ? {} : { capability: entry.capability }),
      ...(entry.limit === undefined ? {} : { limit: entry.limit }),
      ...(entry.object === undefined ? {} : { object: entry.object }),
      ...(source === undefined ? {} : { sourceRef: source }),
      evidence: entry.evidence ?? [],
      confidence: entry.confidence ?? MIN_CONFIDENCE,
      detectedAt: request.detectedAt,
    });
  }
}

/** A statement that survived the shape check, so its required fields are present. */
type UsableStatement = RawStatement & {
  kind: StatedKind;
  statement: string;
  subject: string;
};

interface RawStatement {
  kind?: string;
  statement?: string;
  subject?: string;
  principal?: string;
  capability?: string;
  limit?: number;
  object?: string;
  confidence?: number;
  evidence?: string[];
}

/** Half a statement is dropped silently; a reviewer's time is the scarce thing. */
function isUsable(entry: RawStatement): entry is UsableStatement {
  if (typeof entry.statement !== 'string' || entry.statement.length === 0) return false;
  if (typeof entry.subject !== 'string' || entry.subject.length === 0) return false;
  if (typeof entry.kind !== 'string' || !isKind(entry.kind)) return false;
  return (entry.confidence ?? MIN_CONFIDENCE) >= MIN_CONFIDENCE;
}

function isKind(candidate: string): candidate is StatedKind {
  return KINDS.includes(candidate);
}

/** A model that answers with prose around its JSON has still answered. */
function parseStatements(raw: string): RawStatement[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(parsed) ? (parsed as RawStatement[]) : [];
  } catch {
    // A malformed answer is an empty run: half a claim is worse than none.
    return [];
  }
}

function renderMessages(messages: readonly SourceMessage[]): string {
  return messages
    .map(
      (message) =>
        `[${message.id}] ${message.author} (${message.occurredAt}): ${message.text}`,
    )
    .join('\n');
}

/** The permalink of the first message the statement cites, when it cites one. */
function sourceOf(
  evidence: string[] | undefined,
  messages: readonly SourceMessage[],
): string | undefined {
  if (evidence === undefined || evidence.length === 0) return undefined;
  const cited = messages.find((message) => message.id === evidence[0]);
  if (cited === undefined) return undefined;
  return cited.sourceRef;
}
