// The quota rows (#171, #132 §5): what the quota engine knows of each request
// family, per company and provider — the provider's last reading and since
// when the family is exhausted or its key refused. The worker writes a
// family's row after every job that learned something of it, and reads the
// rows back before a job so a fresh process adopts them; `GET
// /routing/quota` reads them for the office's banner, and S5's preview writes
// them from the API. Fenced like every table: each company sees and writes
// its own rows (the key is one account the companies share; ADR-0009).
import type { RoutingQuotaStanding } from "@waste/domain/routing/quota"
import { ROUTING_QUOTA_FAMILIES, type RoutingQuotaFamily } from "@waste/domain/routing/vocabulary"
import { and, eq } from "drizzle-orm"

import type { Tx } from "../client"
import { routingQuota } from "../schema/routing"

/** A family's standing as stored (@waste/domain/routing/quota), with the family it is of and the instant it was written. */
export type QuotaRow = RoutingQuotaStanding & {
  family: RoutingQuotaFamily
  /** When the row was last written: the instant the engine adopts it as learned. */
  updatedAt: Date
}

/** The company's rows for one provider, in the vocabulary's order; a family never asked of it has none. */
export async function quotaRows(tx: Tx, keys: { companyId: string; provider: string }): Promise<QuotaRow[]> {
  const rows = await tx
    .select({
      family: routingQuota.family,
      remaining: routingQuota.remaining,
      limit: routingQuota.limit,
      resetAt: routingQuota.resetAt,
      exhaustedAt: routingQuota.exhaustedAt,
      keyRefusedAt: routingQuota.keyRefusedAt,
      updatedAt: routingQuota.updatedAt,
    })
    .from(routingQuota)
    .where(and(eq(routingQuota.companyId, keys.companyId), eq(routingQuota.provider, keys.provider)))
  const order = (family: string) => ROUTING_QUOTA_FAMILIES.indexOf(family as RoutingQuotaFamily)
  return rows.map((row) => ({ ...row, family: row.family as RoutingQuotaFamily })).sort((a, b) => order(a.family) - order(b.family))
}

/** Writes a family's standing, making the row the first time; the trigger moves `updated_at`. */
export async function recordQuota(tx: Tx, keys: { companyId: string; provider: string; family: RoutingQuotaFamily }, standing: RoutingQuotaStanding): Promise<void> {
  const { remaining, limit, resetAt, exhaustedAt, keyRefusedAt } = standing
  const set = { remaining, limit, resetAt, exhaustedAt, keyRefusedAt }
  await tx
    .insert(routingQuota)
    .values({ ...keys, ...set })
    .onConflictDoUpdate({ target: [routingQuota.companyId, routingQuota.provider, routingQuota.family], set })
}
