import { describe, expect, it } from 'vitest';
import {
  buildStack,
  layerOf,
  POLICY_LAYER,
  policiesOf,
  type LayerInput,
} from '../src/policy/layers';
import type { Policy } from '../src/policy/policy';

const rule = (name: string, action: string, effect: string): Policy =>
  ({
    name,
    match: { actions: [action] },
    decision: { effect, reason: `${name} says so` },
  }) as unknown as Policy;

const org = (policies: Policy[], locked?: string[]): LayerInput => ({
  layer: POLICY_LAYER.ORG,
  file: 'org.yaml',
  policies,
  ...(locked === undefined ? {} : { locked }),
});
const project = (policies: Policy[]): LayerInput => ({
  layer: POLICY_LAYER.PROJECT,
  file: 'memnox.policies.yaml',
  policies,
});

describe('stacking org, user and project', () => {
  it('keeps every layer, and remembers which file each rule came from', () => {
    const { stack } = buildStack([
      project([rule('p', 'deploy.service', 'ask')]),
      org([rule('o', 'database.delete', 'deny')]),
    ]);

    expect(policiesOf(stack)).toHaveLength(2);
    // Sorted outermost first regardless of the order they were handed over.
    expect(stack.policies[0]?.layer).toBe(POLICY_LAYER.ORG);
    expect(layerOf(stack, 'p')?.file).toBe('memnox.policies.yaml');
  });

  it('lets a project tighten what the org allowed', () => {
    const { stack, refused } = buildStack([
      org([rule('o', 'deploy.service', 'ask')], ['deploy.']),
      project([rule('p', 'deploy.service', 'deny')]),
    ]);

    expect(refused).toEqual([]);
    expect(policiesOf(stack).map((each) => each.name)).toEqual(['o', 'p']);
  });

  it('refuses a project rule that would loosen a locked one, rather than applying it', () => {
    const { stack, refused } = buildStack([
      org([rule('o', 'database.delete', 'deny')], ['database.']),
      project([rule('p', 'database.delete', 'allow')]),
    ]);

    expect(policiesOf(stack).map((each) => each.name)).toEqual(['o']);
    expect(refused[0]).toMatchObject({ policy: 'p', layer: POLICY_LAYER.PROJECT });
    expect(refused[0]?.reason).toContain('may only tighten');
  });

  it('says which file the refused rule was in, so somebody can go and fix it', () => {
    const { refused } = buildStack([
      org([rule('o', 'deploy.x', 'deny')], ['deploy.']),
      project([rule('p', 'deploy.x', 'ask')]),
    ]);
    expect(refused[0]?.file).toBe('memnox.policies.yaml');
  });

  it('leaves an unlocked domain alone, however the project rules it', () => {
    const { refused } = buildStack([
      org([rule('o', 'deploy.service', 'deny')]),
      project([rule('p', 'deploy.service', 'allow')]),
    ]);
    expect(refused).toEqual([]);
  });

  it('locks nothing by default, because a floor nobody set is not a floor', () => {
    const { stack } = buildStack([org([rule('o', 'a.b', 'deny')])]);
    expect(stack.locked).toEqual([]);
  });

  it('treats a user layer as between the two', () => {
    const { stack } = buildStack([
      project([rule('p', 'a.b', 'deny')]),
      {
        layer: POLICY_LAYER.USER,
        file: 'user.yaml',
        policies: [rule('u', 'a.c', 'ask')],
      },
      org([rule('o', 'a.d', 'deny')]),
    ]);
    expect(stack.policies.map((each) => each.layer)).toEqual(['org', 'user', 'project']);
  });
});
