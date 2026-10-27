// Apply index over many prices (#291 C8, rows 13.5 and 13.6): a percent from
// a day, judged row by row. An indexation is a new row and never an update
// (§7.18): the row in force on the day ends on it, and its successor runs
// from the day to the old row's end at the indexed price, so the price on
// any day stays a read of the row in force on it and the chain through
// `indexedFromId` is the history. The one price is `indexedFee`
// (finance/money.ts), half away from zero, the provider price's single index
// and every bulk one alike.
//
// A row in the plan is in force on the day or starts after it; a row that
// ended on or before it is over and not the caller's to hand in. What is
// indexed is a row that started before the day and is in force on it; what
// is left, with its reason: a row that starts on the day, already that day's
// price (a new tariff year typed in by hand), a row that starts later, a
// price set for then and left as it was set, and a row whose product is no
// longer active, since the successor would be a new reference to it (#79).
// A price out of range — below zero, or past the `integer` column — is the
// whole request's refusal, never a row's skip, so the plan says which row and
// leaves the answer to the caller.
import { fitsMinor, indexedFee } from "./money"
import type { IndexSkipReason } from "./vocabulary"

/** What the plan reads of a row: its period, the amount the index multiplies, and whether its product takes a new reference. */
export interface IndexableRow {
  readonly id: string
  readonly validFrom: string
  readonly validTo: string | null
  /** What is multiplied: a customer row's price, or a provider price's bid or current fee. */
  readonly baseMinor: number
  /** What the row charges now, the line's "before". */
  readonly unitPriceMinor: number
  readonly productActive: boolean
}

/** One row's verdict: indexed at a price, or skipped for a reason. */
export type IndexVerdict =
  | { readonly id: string; readonly outcome: "indexed"; readonly fromMinor: number; readonly toMinor: number }
  | { readonly id: string; readonly outcome: "skipped"; readonly fromMinor: number; readonly reason: IndexSkipReason }

/** Why a whole plan is refused: a row's indexed price below zero, or past what a price holds. */
export type IndexOutOfRange = { readonly id: string; readonly problem: "below-zero" | "too-large"; readonly toMinor: number }

export interface IndexPlan {
  readonly verdicts: readonly IndexVerdict[]
  /** The first row whose price would not do, in the rows' order; undefined when every indexed price is a price. */
  readonly outOfRange: IndexOutOfRange | undefined
}

/** Whether a row is in the plan at all: in force on the day, or starting after it. A half-open period, `validTo` the first day out. */
export const inIndexPlan = (row: Pick<IndexableRow, "validTo">, appliedFrom: string): boolean => row.validTo === null || row.validTo > appliedFrom

/** The verdict on one row. */
function verdictOf(row: IndexableRow, appliedFrom: string, basisPoints: number): IndexVerdict {
  const skipped = (reason: IndexSkipReason): IndexVerdict => ({ id: row.id, outcome: "skipped", fromMinor: row.unitPriceMinor, reason })
  if (row.validFrom > appliedFrom) return skipped("scheduled")
  if (row.validFrom === appliedFrom) return skipped("starts-on-index-day")
  if (!row.productActive) return skipped("product-not-active")
  return { id: row.id, outcome: "indexed", fromMinor: row.unitPriceMinor, toMinor: indexedFee(row.baseMinor, basisPoints) }
}

/**
 * The plan of an Apply index from `appliedFrom` by `basisPoints` (500 for
 * +5 %, negative a deflator) over the rows handed in, in their order; a row
 * that ended on or before the day is left out. A preview and a write of one
 * body over the same rows read the same plan.
 */
export function planIndexation(rows: readonly IndexableRow[], appliedFrom: string, basisPoints: number): IndexPlan {
  const verdicts = rows.filter((row) => inIndexPlan(row, appliedFrom)).map((row) => verdictOf(row, appliedFrom, basisPoints))
  let outOfRange: IndexOutOfRange | undefined
  for (const verdict of verdicts) {
    if (verdict.outcome !== "indexed") continue
    if (verdict.toMinor < 0) outOfRange = { id: verdict.id, problem: "below-zero", toMinor: verdict.toMinor }
    else if (!fitsMinor(verdict.toMinor)) outOfRange = { id: verdict.id, problem: "too-large", toMinor: verdict.toMinor }
    if (outOfRange !== undefined) break
  }
  return { verdicts, outOfRange }
}

/** The rows a plan writes: its indexed verdicts. */
export const indexedOf = (plan: IndexPlan) => plan.verdicts.filter((verdict): verdict is Extract<IndexVerdict, { outcome: "indexed" }> => verdict.outcome === "indexed")

/** What a write that would index nothing is told: no row runs into the day from an earlier one. A preview answers its lines instead. */
export const nothingToIndex = (appliedFrom: string): string => `Nothing to index: no price runs into ${appliedFrom} from an earlier day`
