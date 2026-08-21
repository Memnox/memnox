import type { DecisionRecord } from './decision-record';
import { isEnforcing } from './decision-record';

/** Preloads the constraints, rather than discovering them one blocked action at a time. */
export function buildDecisionDigest(decisions: DecisionRecord[]): string {
  const active = decisions.filter(isEnforcing);
  if (active.length === 0)
    return 'No recorded team decisions currently constrain AI actions.\n';

  const lines = ['# Team decisions constraining AI actions', ''];
  for (const decision of active) {
    const scope = [
      `actions: ${decision.actions.join(', ')}`,
      decision.targets !== undefined && decision.targets.length > 0
        ? `targets: ${decision.targets.join(', ')}`
        : null,
      decision.environments !== undefined && decision.environments.length > 0
        ? `environments: ${decision.environments.join(', ')}`
        : null,
    ]
      .filter(Boolean)
      .join('; ');
    const source = decision.sourceRef ? ` [source](${decision.sourceRef})` : '';
    lines.push(
      `- **${decision.title}** (${decision.owner}, ${decision.enforcement}): ${decision.statement} — ${scope}${source}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
