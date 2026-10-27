// What the two Apply index routes over many prices share (#291 C8): the
// refusals of a plan and the lines of its answer. The plan itself is the
// domain's (@waste/domain/finance/indexation), so `POST /price-lists/:id/index`
// and `POST /service-provider-prices/index` judge a row the same way, and the
// single provider index prices through the same `indexedFee`. Each route
// reads its rows under their locks, hands them to `planIndexation`, refuses
// what `refusePlan` refuses, writes the indexed verdicts as its own table's
// successors, and answers `answerOf`.
import type { IndexLine, IndexResult } from "@waste/contracts/finance"
import { INT4_MAX } from "@waste/contracts/resource"
import { nothingToIndex, type IndexPlan } from "@waste/domain/finance/indexation"

import { invalidRequest, problem } from "../problem"

/** What an index that takes a price below zero is told, at `basisPoints`: a deflator past -100 % would make a price negative. */
export const INDEX_PRICE_BELOW_ZERO = "The index would take a price below zero"

/** What an index whose price is past the column is told, at `basisPoints`. */
export const INDEX_PRICE_TOO_LARGE = `An indexed price would be more than ${INT4_MAX} minor units, the most a price holds`

/**
 * The plan's refusals, in the order a route judges: the body's basis points
 * when a price would not do (400, a preview's too, since its answer would
 * name a price nobody can write), then, on a write alone, a plan that indexes
 * nothing (409: the rows' state, not the body, refuses it). A preview of
 * such a plan answers its lines.
 */
export function refusePlan(plan: IndexPlan, appliedFrom: string, dryRun: boolean): void {
  if (plan.outOfRange !== undefined) throw invalidRequest("body", [{ path: "basisPoints", message: plan.outOfRange.problem === "below-zero" ? INDEX_PRICE_BELOW_ZERO : INDEX_PRICE_TOO_LARGE }])
  if (!dryRun && !plan.verdicts.some((verdict) => verdict.outcome === "indexed")) throw problem(409, { detail: nothingToIndex(appliedFrom) })
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
