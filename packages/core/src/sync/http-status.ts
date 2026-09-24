/** The HTTP status codes this runtime reads, named once and shared with the CLI. */
export const HTTP = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  /** The bundle is unchanged, which is what a conditional GET asks for. */
  NOT_MODIFIED: 304,
  BAD_REQUEST: 400,
  /** The credential was refused: a revoked machine, or a hand-edited account file. */
  UNAUTHORIZED: 401,
  /** The workspace's plan does not cover this. */
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  /** No such route, which for an optional door means a control plane older than it. */
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  /** Somebody else holds it, which is how the shared register refuses a lease. */
  CONFLICT: 409,
  NOT_IMPLEMENTED: 501,
  BAD_GATEWAY: 502,
} as const;

/** Where the credential itself was refused, which is a different fix from a fault. */
export function isCredentialRefused(status: number): boolean {
  return status === HTTP.UNAUTHORIZED || status === HTTP.FORBIDDEN;
}

/** Where the route is simply not there, which is a control plane older than it. */
export function isRouteMissing(status: number): boolean {
  return (
    status === HTTP.NOT_FOUND ||
    status === HTTP.METHOD_NOT_ALLOWED ||
    status === HTTP.NOT_IMPLEMENTED
  );
}
