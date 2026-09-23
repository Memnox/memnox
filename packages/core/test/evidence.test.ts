import { describe, expect, it } from 'vitest';
import { evidenceFor } from '../src/gate/evidence';
import type { MatchedPolicy } from '../src/domain/decision';

const MOMENT = '2026-09-24T12:00:00.000Z';
const REASON = 'you chose to be asked about this: unknown hosts';

function ask(name: string, reason = REASON): MatchedPolicy {
  return { name, effect: 'ask', reason };
}

describe('evidenceFor', () => {
  it('says one rule once however many files carry it', () => {
    const matched = [
      ask('network-ask'),
      ask('b02784c914f9bebe9f25a687a1d08ba7'),
      ask('network-ask'),
      ask('network-ask'),
    ];
    expect(evidenceFor({ matched, moment: MOMENT })).toEqual([
      { source: 'rule', detail: `network-ask: ${REASON}` },
    ]);
  });

  it('names a published rule a team rule rather than by its hash', () => {
    const matched = [ask('b02784c914f9bebe9f25a687a1d08ba7')];
    expect(evidenceFor({ matched, moment: MOMENT })).toEqual([
      { source: 'rule', detail: `team rule: ${REASON}` },
    ]);
  });

  it('keeps rules that say different things', () => {
    const matched = [ask('network-ask'), ask('shell-ask', 'a shell command')];
    expect(evidenceFor({ matched, moment: MOMENT })).toHaveLength(2);
  });
});
