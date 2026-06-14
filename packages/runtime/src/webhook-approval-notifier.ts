import type { Approval, ApprovalNotifier } from '@memnox/core';

const NOTIFY_TIMEOUT_MS = 5_000;

/** Posts new pending approvals to a Slack-compatible incoming webhook. */
export class WebhookApprovalNotifier implements ApprovalNotifier {
  constructor(private readonly webhookUrl: string) {}

  async notify(approval: Approval): Promise<void> {
    const target = approval.target ? ` on ${approval.target}` : '';
    const environment = approval.environment ? ` in ${approval.environment}` : '';
    const text =
      `Memnox approval needed: ${approval.action}${target}${environment}\n` +
      `Approvers: ${approval.approvers.join(', ')}\n` +
      `Resolve: memnox approvals resolve ${approval.id} --by <you>`;

    // Buttons resolve via POST /v1/integrations/slack/interactions when the
    // webhook belongs to a Slack app with interactivity configured.
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text } },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Approve' },
            style: 'primary',
            action_id: 'memnox_approve',
            value: approval.id,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Deny' },
            style: 'danger',
            action_id: 'memnox_deny',
            value: approval.id,
          },
        ],
      },
    ];

    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, blocks, approval }),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`webhook responded ${response.status}`);
    }
  }
}
