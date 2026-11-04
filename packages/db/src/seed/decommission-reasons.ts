// The demo company's Decommission Reasons (O30 of #290, row 9.6): the eight
// every company starts with (@waste/domain/resources/decommission-reasons),
// company-wide. The migration gave them to every company it found, on ids of
// its own minting, so a reason the company already holds by its code is
// left as it stands rather than written again under the seed's id; the
// reasons are the tenant's once there — the office renames and retires them —
// so nothing is ever restored, and a run that finds them writes nothing.
import type { Tx } from "../client"
import { defaultDecommissionReasonRows } from "../commands/provision-company"
import { decommissionReason } from "../schema/stock"
import { counted, DEMO_COMPANY_ID } from "./ids"

const next = counted("decommissionReason")

const ROWS: readonly (typeof decommissionReason.$inferInsert)[] = defaultDecommissionReasonRows(DEMO_COMPANY_ID, next)

/** Every decommission reason id the seed writes, by code. */
export const DECOMMISSION_REASON_IDS: Readonly<Record<string, string>> = Object.fromEntries(ROWS.map((row) => [row.code, row.id as string]))

export const DECOMMISSION_REASONS_COUNTS = { decommissionReasons: ROWS.length }
export type DecommissionReasonsCounts = typeof DECOMMISSION_REASONS_COUNTS

/** Writes the reasons the company lacks into an open transaction, and answers how many it wrote: none where it holds them all, by id or by code. */
export async function applyDecommissionReasons(tx: Tx): Promise<number> {
  const written = await tx.insert(decommissionReason).values([...ROWS]).onConflictDoNothing().returning({ id: decommissionReason.id })
  return written.length
}
