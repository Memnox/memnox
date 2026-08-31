import { TENANT_ISOLATION, type TenantIsolation } from './source.constants';

/**
 * Where one organization's data lives. Shared is the default; an enterprise tenant gets
 * its own database and a region its raw documents do not leave.
 */
export interface Tenant {
  workspaceId: string;
  isolation: TenantIsolation;
  /** Set only for a dedicated tenant. Raw documents never leave it. */
  region?: string;
  /** The database a dedicated tenant owns. Absent means the shared one. */
  databaseRef?: string;
}

export const TENANCY_REFUSAL = {
  NO_REGION: 'a dedicated tenant must name the region its data stays in',
  NO_DATABASE: 'a dedicated tenant must name the database it owns',
  SHARED_REGION:
    'a shared tenant cannot pin a region — it lives where the shared database does',
  WRONG_TENANT: 'that record belongs to another workspace',
  CROSS_REGION: 'that read would take data out of the region the tenant is pinned to',
} as const;

export type TenantCheck = { ok: true } | { ok: false; reason: string };

/**
 * Refused at configuration rather than at read time. A dedicated tenant with no region
 * is a promise nobody can keep, and a shared tenant claiming one is a promise that is
 * already false.
 */
export function validateTenant(tenant: Tenant): TenantCheck {
  if (tenant.isolation === TENANT_ISOLATION.DEDICATED) {
    if (tenant.region === undefined || tenant.region.length === 0) {
      return { ok: false, reason: TENANCY_REFUSAL.NO_REGION };
    }
    if (tenant.databaseRef === undefined || tenant.databaseRef.length === 0) {
      return { ok: false, reason: TENANCY_REFUSAL.NO_DATABASE };
    }
    return { ok: true };
  }
  if (tenant.region !== undefined) {
    return { ok: false, reason: TENANCY_REFUSAL.SHARED_REGION };
  }
  return { ok: true };
}

/** Anything a tenant-scoped store reads or writes carries the workspace it belongs to. */
export interface Tenanted {
  workspaceId: string;
}

/**
 * Every read is filtered here rather than by each caller remembering to add a clause.
 * Filtering after retrieval means the material was already in a process answering to a
 * different identity, which is the design that produces the breach and is invisible in
 * testing because the answers look correct.
 */
export function scopeTo<T extends Tenanted>(tenant: Tenant, records: readonly T[]): T[] {
  return records.filter((record) => record.workspaceId === tenant.workspaceId);
}

/** A write to another workspace is refused rather than filtered away silently. */
export function guardWrite(tenant: Tenant, record: Tenanted): TenantCheck {
  if (record.workspaceId !== tenant.workspaceId) {
    return { ok: false, reason: TENANCY_REFUSAL.WRONG_TENANT };
  }
  return { ok: true };
}

/**
 * A dedicated tenant's raw documents stay in its region. Reading them from elsewhere is
 * refused, because the guarantee an enterprise bought is exactly this one.
 */
export function guardRegion(tenant: Tenant, readingFrom: string): TenantCheck {
  if (tenant.isolation !== TENANT_ISOLATION.DEDICATED) return { ok: true };
  if (tenant.region === readingFrom) return { ok: true };
  return { ok: false, reason: TENANCY_REFUSAL.CROSS_REGION };
}

export function sharedTenant(workspaceId: string): Tenant {
  return { workspaceId, isolation: TENANT_ISOLATION.SHARED };
}

export function dedicatedTenant(
  workspaceId: string,
  region: string,
  databaseRef: string,
): Tenant {
  return { workspaceId, isolation: TENANT_ISOLATION.DEDICATED, region, databaseRef };
}

export interface TenantStore {
  save(tenant: Tenant): Promise<void>;
  findByWorkspace(workspaceId: string): Promise<Tenant | null>;
}
