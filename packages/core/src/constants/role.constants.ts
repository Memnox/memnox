export const API_ROLE = {
  VIEWER: 'viewer',
  APPROVER: 'approver',
  ADMIN: 'admin',
} as const;

export type ApiRole = (typeof API_ROLE)[keyof typeof API_ROLE];

/** Higher value includes every permission below it. */
export const ROLE_PRECEDENCE: Record<ApiRole, number> = {
  [API_ROLE.VIEWER]: 0,
  [API_ROLE.APPROVER]: 1,
  [API_ROLE.ADMIN]: 2,
};

export function roleSatisfies(actual: ApiRole, required: ApiRole): boolean {
  return ROLE_PRECEDENCE[actual] >= ROLE_PRECEDENCE[required];
}
