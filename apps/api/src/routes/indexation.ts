// What the Apply index routes share (#291 C8): the refusals of a plan, the
// products' statuses a plan reads, the batches a write is cut into, and the
// lines of its answer. The plan itself is the domain's
// (@waste/domain/finance/indexation), so `POST /price-lists/:id/index`, `POST
// /service-provider-prices/index` and the single `POST
// /service-provider-prices/:id/index` judge a row the same way. Each route
// reads its rows under its locks, hands them to `planIndexation`, refuses
// what `refusePlan` refuses, writes the indexed verdicts as its own table's
// successors in `WRITE_BATCH`es, and answers `answerOf`.
//
// An Apply index over many prices is all or nothing, an exception to the
// rule that a command over many rows answers each row's refusal as that row's
// result (`POST /routes/dispatch`): one index, one label and one day are one
// body, and a price that body cannot write (below zero, past `integer`) is the
// basis points' 400, the field the caller fixes for every row at once. The
// rows a body leaves as they are — they start on the day or later, or their
// product is no longer active — are judged per row and answered on their
// lines, since nothing in the body would change them.
import type { IndexLine, IndexResult } from "@waste/contracts/finance"
import { INT4_MAX } from "@waste/contracts/resource"
import type { Tx } from "@waste/db/client"
import { product } from "@waste/db/schema/catalogue"
import { nothingToIndex, type IndexPlan } from "@waste/domain/finance/indexation"
import type { ProductStatus } from "@waste/domain/registry/vocabulary"
import { and, eq, inArray } from "drizzle-orm"

import { lockRows, type TenantTable } from "./shared"

import type { Principal } from "../auth/principal"
import { inProjects } from "../auth/projects"
import { invalidRequest, problem } from "../problem"

/** What an index that takes a price below zero is told, at `basisPoints`: a deflator past -100 % would make a price negative. */
export const INDEX_BELOW_ZERO = "The index would take a price below zero"

/** What an index whose price is past the column is told, at `basisPoints`. */
export const INDEX_TOO_LARGE = `An indexed price would be more than ${INT4_MAX} minor units, the most a price holds`

/**
 * The rows one statement of a write names at most: a successor binds about
 * seventeen parameters, and Postgres takes 65 535 in a statement, so a list
 * of thousands of rows is written in batches inside the one transaction.
 */
export const WRITE_BATCH = 1_000

/** `items` in batches of `size`, in order. */
export function batchesOf<T>(items: readonly T[], size = WRITE_BATCH): T[][] {
  const batches: T[][] = []
  for (let start = 0; start < items.length; start += size) batches.push(items.slice(start, start + size))
  return batches
}

/** `lockRows` over any number of rows: the ids in order, a batch at a time, so the locks are still taken in id order and no statement passes the parameters it takes. */
export async function lockInBatches(tx: Tx, table: TenantTable, companyId: string, ids: readonly string[]): Promise<void> {
  for (const batch of batchesOf([...new Set(ids)].sort())) await lockRows(tx, table, companyId, batch)
}

/**
 * The plan's refusals, in the order a route judges: the body's basis points
 * when a price would not do (400, a preview's too, since its answer would
 * name a price nobody can write), then, on a write alone, a plan that indexes
 * nothing (409: the rows' state, not the body, refuses it). A preview of
 * such a plan answers its lines.
 */
export function refusePlan(plan: IndexPlan, appliedFrom: string, dryRun: boolean): void {
  if (plan.outOfRange !== undefined) throw invalidRequest("body", [{ path: "basisPoints", message: plan.outOfRange.problem === "below-zero" ? INDEX_BELOW_ZERO : INDEX_TOO_LARGE }])
  if (!dryRun && !plan.verdicts.some((verdict) => verdict.outcome === "indexed")) throw problem(409, { detail: nothingToIndex(appliedFrom) })
}

/** The status of each product the rows name, in one statement per batch and inside the caller's projects: a successor is a new reference to its product, so an inactive one is a row the plan skips (routes/statuses.ts). */
export async function productStatuses(tx: Tx, principal: Principal, ids: readonly string[]): Promise<Map<string, ProductStatus>> {
  const statuses = new Map<string, ProductStatus>()
  for (const batch of batchesOf([...new Set(ids)])) {
    const rows = await tx
      .select({ id: product.id, status: product.status })
      .from(product)
      .where(and(eq(product.companyId, principal.companyId), inProjects(product.projectId, principal), inArray(product.id, batch)))
    // The column's CHECK holds it to the Registry's tuple.
    for (const row of rows) statuses.set(row.id, row.status as ProductStatus)
  }
  return statuses
}

/** The answer: the body's index again and a line per verdict, the successor's id once written. */
export function answerOf(
  index: { label: string; basisPoints: number; appliedFrom: string; dryRun?: boolean },
  plan: IndexPlan,
  productOf: (id: string) => string,
  successors: ReadonlyMap<string, string>,
): IndexResult {
  const lines: IndexLine[] = plan.verdicts.map((verdict) =>
    verdict.outcome === "indexed"
      ? { id: verdict.id, productId: productOf(verdict.id), fromMinor: verdict.fromMinor, toMinor: verdict.toMinor, indexedId: successors.get(verdict.id) ?? null, skipped: null }
      : { id: verdict.id, productId: productOf(verdict.id), fromMinor: verdict.fromMinor, toMinor: null, indexedId: null, skipped: verdict.reason },
  )
  return { dryRun: index.dryRun === true, label: index.label, basisPoints: index.basisPoints, appliedFrom: index.appliedFrom, lines }
}
