import { RISK_ORDER, type RiskLevel } from '@memnox/core';
import { classifyRisk } from '@memnox/policy-engine';
import type { LlmProvider } from './llm-provider';

const INTENT_MAX_TOKENS = 400;
/** Candidate actions kept per goal — enough to plan against, few enough to read. */
const MAX_CANDIDATES = 6;

const INTENT_SYSTEM = [
  'You map a stated engineering goal onto the concrete actions carrying it out.',
  'Reply with JSON only: {"actions":[{"action":"<namespace.verb>","target":"<path or resource>","why":"<short>"}]}.',
  'Use namespaced verbs such as database.migrate, database.delete, code.modify, deploy.service, shell.execute.',
  'List what the goal would plausibly require. Never judge whether it is allowed.',
].join(' ');

export interface IntentCandidate {
  action: string;
  target?: string;
  why: string;
  /** Deterministic classification of the candidate, not the model's opinion. */
  riskLevel: RiskLevel;
}

export interface IntentAnalysis {
  goal: string;
  candidates: IntentCandidate[];
  /** The riskiest thing this goal could turn into. */
  highestRisk: RiskLevel;
}

/** Advisory only — the gate still decides on each action. */
export class IntentClassifier {
  constructor(private readonly llm: LlmProvider) {}

  async classify(goal: string, environment?: string): Promise<IntentAnalysis> {
    const raw = await this.llm.complete({
      system: INTENT_SYSTEM,
      prompt: `Goal: ${goal}`,
      maxTokens: INTENT_MAX_TOKENS,
    });
    const candidates = parseCandidates(raw, environment);
    return { goal, candidates, highestRisk: highestOf(candidates) };
  }
}

function parseCandidates(raw: string, environment?: string): IntentCandidate[] {
  const json = raw.replace(/```json|```/g, '').trim();
  const match = json.match(/\{[\s\S]*\}/);
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[0]) as { actions?: unknown[] };
    return (parsed.actions ?? [])
      .flatMap((entry) => toCandidate(entry, environment))
      .slice(0, MAX_CANDIDATES);
  } catch {
    // Model output is untrusted input — a malformed reply yields no candidates.
    return [];
  }
}

function toCandidate(entry: unknown, environment?: string): IntentCandidate[] {
  const record = entry as Record<string, unknown>;
  const action = record['action'];
  if (typeof action !== 'string' || action.length === 0) return [];
  const target = record['target'];
  return [
    {
      action,
      ...(typeof target === 'string' && target ? { target } : {}),
      why: typeof record['why'] === 'string' ? record['why'] : '',
      riskLevel: classifyRisk(action, environment),
    },
  ];
}

function highestOf(candidates: readonly IntentCandidate[]): RiskLevel {
  return candidates.reduce<RiskLevel>((highest, candidate) => {
    return RISK_ORDER.indexOf(candidate.riskLevel) > RISK_ORDER.indexOf(highest)
      ? candidate.riskLevel
      : highest;
  }, RISK_ORDER[0] ?? 'low');
}
