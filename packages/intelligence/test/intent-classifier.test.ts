import { describe, expect, it } from 'vitest';
import { RISK_LEVEL } from '@memnox/core';
import { IntentClassifier } from '../src/intent-classifier';
import type { LlmProvider } from '../src/llm-provider';

const replying = (text: string): LlmProvider => ({
  name: 'fake',
  complete: async () => text,
});

const ACTIONS = JSON.stringify({
  actions: [
    { action: 'database.migrate', target: 'users', why: 'add an index' },
    { action: 'database.delete', target: 'audit_log', why: 'prune old rows' },
    { action: 'code.modify', target: 'src/db.ts', why: 'tune the query' },
  ],
});

describe('IntentClassifier', () => {
  it('expands a vague goal into concrete candidate actions', async () => {
    const analysis = await new IntentClassifier(replying(ACTIONS)).classify(
      'improve database performance',
    );

    expect(analysis.goal).toBe('improve database performance');
    expect(analysis.candidates.map((c) => c.action)).toEqual([
      'database.migrate',
      'database.delete',
      'code.modify',
    ]);
  });

  it('classifies risk itself rather than trusting the model', async () => {
    const analysis = await new IntentClassifier(replying(ACTIONS)).classify('goal');
    const destructive = analysis.candidates.find((c) => c.action === 'database.delete');

    expect(destructive?.riskLevel).toBe(RISK_LEVEL.HIGH);
    expect(analysis.highestRisk).toBe(RISK_LEVEL.HIGH);
  });

  it('escalates risk in a production environment', async () => {
    const analysis = await new IntentClassifier(replying(ACTIONS)).classify(
      'goal',
      'production',
    );
    expect(analysis.highestRisk).toBe(RISK_LEVEL.CRITICAL);
  });

  it('reads a reply wrapped in markdown fences', async () => {
    const fenced = `Here you go:\n\`\`\`json\n${ACTIONS}\n\`\`\``;
    const analysis = await new IntentClassifier(replying(fenced)).classify('goal');
    expect(analysis.candidates).toHaveLength(3);
  });

  it('yields no candidates for malformed output rather than throwing', async () => {
    for (const reply of ['not json at all', '{"actions": "nope"', '']) {
      const analysis = await new IntentClassifier(replying(reply)).classify('goal');
      expect(analysis.candidates).toEqual([]);
      expect(analysis.highestRisk).toBe(RISK_LEVEL.LOW);
    }
  });

  it('drops entries with no action name', async () => {
    const partial = JSON.stringify({
      actions: [{ why: 'no action field' }, { action: 'code.read' }],
    });
    const analysis = await new IntentClassifier(replying(partial)).classify('goal');
    expect(analysis.candidates.map((c) => c.action)).toEqual(['code.read']);
  });

  it('caps how many candidates it returns', async () => {
    const many = JSON.stringify({
      actions: Array.from({ length: 20 }, (_, i) => ({ action: `code.step${i}` })),
    });
    const analysis = await new IntentClassifier(replying(many)).classify('goal');
    expect(analysis.candidates.length).toBeLessThanOrEqual(6);
  });
});
