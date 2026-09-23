// The tenant fence of ADR-0001: row-level security on every domain table, one
// policy, one shape. Hand-written into the table's migration file (drizzle-kit
// is not asked to manage policies, so there is one owner of the statement and
// no second spelling), and this function is the place that spells it:
//
//   ALTER TABLE "wms"."agreement" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
//   CREATE POLICY "agreement_tenant_fence" ON "wms"."agreement" AS PERMISSIVE FOR ALL TO wms_api
//     USING ("company_id" = (select wms.current_company_id()))
//     WITH CHECK ("company_id" = (select wms.current_company_id()));
//
// The API connects as wms_api, which owns nothing and bypasses nothing, so the
// policy applies to every statement it runs. `wms.current_company_id()` reads
// the setting the request's transaction made (tenant.ts, `withCompany`), and a
// transaction that set none reads null: null equals nothing, so such a
// transaction sees no rows and can insert none (SQLSTATE 42501). The
// predicate is wrapped in a scalar subquery so the planner evaluates it once
// per statement rather than once per row. FORCE makes the fence apply to the
// table's owner as well, when the owner does not carry BYPASSRLS; Supabase's
// `postgres` does, so migrations and tests as the owner see every row, and the
// API role never does.
import type { PgTable } from "drizzle-orm/pg-core"

import { columnNamed, qualifiedTable, quoted, tableObjectName } from "../names"
import { API_ROLE } from "../roles"

const HELPER = "tenantFence"
/** The suffix of the policy's name. */
export const TENANT_FENCE = "tenant_fence"

/** The statements that fence this table by `company_id`, for the table's migration file. */
export function tenantFence(table: PgTable): string[] {
  const target = qualifiedTable(table, HELPER)
  if (!columnNamed(table, "company_id")) {
    throw new Error(`${HELPER}: ${target} has no company_id; every domain table carries one (spread the tenant column set)`)
  }
  const predicate = `(${quoted("company_id")} = (select wms.current_company_id()))`
  return [
    `ALTER TABLE ${target} ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;`,
    `CREATE POLICY ${quoted(tableObjectName(table, TENANT_FENCE, HELPER))} ON ${target} AS PERMISSIVE FOR ALL TO ${API_ROLE} USING ${predicate} WITH CHECK ${predicate};`,
  ]
}
