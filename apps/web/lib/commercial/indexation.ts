// Indexation as the office types and reads it (#291 C8): a change typed as a
// percent and sent as basis points, a change read back as a signed percent,
// why an Apply index over many prices left a row as it is, and what a plan
// comes to. The prices themselves are the API's (`indexedFee`, half away
// from zero); nothing here computes one.
import type { IndexResult, IndexSkipReason } from "@waste/contracts/finance"

/** What a change that is no whole percent with at most two decimals is told. */
export const INDEX_REFUSAL = "Give the change as a percent with at most two decimals, such as 5 or -1.25"

/**
 * A change typed as a percent, as basis points: `5` is 500, `-1.25` is -125.
 * NaN for anything else. No float: the digits are read as integers.
 */
export function basisPointsOf(text: string): number {
  const match = /^(-)?(\d+)(?:[.,](\d{1,2}))?$/.exec(text.trim())
  if (match === null) return Number.NaN
  const [, sign, whole, fraction = ""] = match
  const points = Number(whole) * 100 + Number(fraction.padEnd(2, "0") || "0")
  return sign === "-" ? -points : points
}

/** Basis points as a signed percent: 500 is `+5%`, -125 is `-1.25%`. */
export const percentLabel = (points: number) => `${points < 0 ? "-" : "+"}${(Math.abs(points) / 100).toFixed(2).replace(/\.?0+$/, "")}%`

/** Why a row stays as it is, as the preview and the answer say it. */
export const SKIP_SENTENCES: Readonly<Record<IndexSkipReason, string>> = {
  "starts-on-index-day": "Starts on that day: it is already that day's price",
  scheduled: "Starts later: a price set for then stays as it was set",
  "product-not-active": "Its product is no longer active",
}

/** What a plan comes to, in a sentence: how many prices move and how many stay. */
export function indexSummary(result: Pick<IndexResult, "lines">): string {
  const moved = result.lines.filter((line) => line.skipped === null).length
  const stayed = result.lines.length - moved
  const prices = (count: number) => `${count} price${count === 1 ? "" : "s"}`
  if (result.lines.length === 0) return "No price is in force on that day or after it."
  return `${prices(moved)} ${moved === 1 ? "moves" : "move"}${stayed === 0 ? "" : `; ${prices(stayed)} ${stayed === 1 ? "stays" : "stay"} as ${stayed === 1 ? "it is" : "they are"}`}.`
}
