import type {
  ActionAdvisor,
  ActionRequest,
  Advisory,
  AdvisoryContext,
} from '@memnox/core';
import { DECISION_EFFECT, describeEgress, inspectEgress } from '@memnox/core';

export const EGRESS_ADVISOR = 'egress';
export const RISK_SIGNAL_CREDENTIAL_EGRESS = 'credential-in-payload';

/** Actions that carry a payload somewhere this machine does not control. */
export const EGRESS_ACTIONS: readonly string[] = [
  'http.request',
  'data.export',
  'email.send',
  'notification.broadcast',
];

/**
 * An allowed host carrying a credential is still a refusal. Escalation-only and
 * deterministic: it never loosens a verdict, it never modifies a payload, and it names
 * the field so somebody can decide whether the rule is wrong.
 */
export class EgressAdvisor implements ActionAdvisor {
  readonly name = EGRESS_ADVISOR;

  constructor(
    private readonly actions: readonly string[] = EGRESS_ACTIONS,
    private readonly approvers: string[] = [],
  ) {}

  async advise(request: ActionRequest, _context: AdvisoryContext): Promise<Advisory[]> {
    if (!this.actions.includes(request.action)) return [];

    // Only the local path ever sees arguments; over the wire this is simply empty.
    const fields = request.arguments;
    if (fields === undefined) return [];

    const inspection = inspectEgress({
      ...(request.target === undefined ? {} : { destination: request.target }),
      fields,
    });
    if (inspection.findings.length === 0) return [];

    return [
      {
        source: this.name,
        escalateTo: DECISION_EFFECT.WITHHOLD,
        reason: describeEgress(inspection),
        signals: [
          RISK_SIGNAL_CREDENTIAL_EGRESS,
          ...inspection.findings.map((finding) => `field:${finding.field}`),
        ],
        ...(this.approvers.length > 0 ? { approvers: [...this.approvers] } : {}),
      },
    ];
  }
}
