/**
 * What kind of condition is in force. Each one is a fact about right now rather than
 * a permission, which is why none of them is a policy: they narrow, and only for as
 * long as they are valid.
 */
export const STATE_FACT_KIND = {
  FREEZE: 'freeze',
  INCIDENT: 'incident',
  CHANGE_WINDOW: 'change-window',
  CUSTOMER_HOLD: 'customer-hold',
} as const;

export type StateFactKind = (typeof STATE_FACT_KIND)[keyof typeof STATE_FACT_KIND];
