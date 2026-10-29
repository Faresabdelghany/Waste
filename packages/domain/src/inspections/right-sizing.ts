// Right-sizing (M23 of #293, row 26.5): a subscription whose containers are
// routinely emptied half-empty, or overflowing, is proposed a size down or
// up, from the fill estimates its drivers recorded (`record-fill`). The rule
// reads the latest `RIGHT_SIZING_WINDOW` estimates of the subscription's
// containers, newest first, and says nothing on fewer than
// `RIGHT_SIZING_MIN`: a median at half full or below is too big, and
// overflowing in `OVERFLOW_MIN` of the latest `OVERFLOW_WINDOW` is too small.
// Overflow is read first, since a bin that overflows on collection days is
// too small whatever its quieter weeks say.
//
// What it becomes is the catalogue's: the product of the same project, kind,
// fraction and frequency whose container type is the next size in the
// direction (`nextSize`), and where none is sold, fewer or more collections
// instead (`directionOf`), which the office decides and makes itself. A
// proposal never changes anything: the office approves it into a
// subscription change, a price change among it, or dismisses it.
import type { FillLevel } from "../execution/vocabulary"
import type { RightSizingDirection } from "./vocabulary"

/** The most estimates the rule reads, newest first. */
export const RIGHT_SIZING_WINDOW = 6
/** The fewest it judges on. */
export const RIGHT_SIZING_MIN = 4
/** Overflowing this many times among the latest `OVERFLOW_WINDOW` makes a container too small. */
export const OVERFLOW_MIN = 2
export const OVERFLOW_WINDOW = 4

/** Each level as a share of the container, overflowing past the whole of it. */
export const FILL_SHARE: Readonly<Record<FillLevel, number>> = { empty: 0, quarter: 25, half: 50, "three-quarters": 75, full: 100, overflowing: 125 }

/** What the estimates say of the container: too big, too small, or nothing to change. */
export type FillReading = { need: "smaller" | "bigger"; medianShare: number; overflowing: number; counted: number } | { need: "none"; counted: number }

/** The reading of the latest estimates, newest first; the rest are not read. */
export function fillReadingOf(newestFirst: readonly FillLevel[]): FillReading {
  const counted = newestFirst.slice(0, RIGHT_SIZING_WINDOW)
  if (counted.length < RIGHT_SIZING_MIN) return { need: "none", counted: counted.length }
  const overflowing = counted.slice(0, OVERFLOW_WINDOW).filter((fill) => fill === "overflowing").length
  const shares = counted.map((fill) => FILL_SHARE[fill]).sort((a, b) => a - b)
  const middle = Math.floor(shares.length / 2)
  const medianShare = shares.length % 2 === 1 ? shares[middle] : (shares[middle - 1] + shares[middle]) / 2
  if (overflowing >= OVERFLOW_MIN) return { need: "bigger", medianShare, overflowing, counted: counted.length }
  if (medianShare <= FILL_SHARE.half) return { need: "smaller", medianShare, overflowing, counted: counted.length }
  return { need: "none", counted: counted.length }
}

/** A product the catalogue sells in the subscription's place, by its container's size. */
export type SizedProduct = { id: string; volumeLitres: number }

/** The product a size down or up: the nearest volume below or above the current one, the lowest id among equals; undefined where none is sold. */
export function nextSize(currentLitres: number, candidates: readonly SizedProduct[], need: "smaller" | "bigger"): SizedProduct | undefined {
  const sorted = candidates.filter((candidate) => (need === "smaller" ? candidate.volumeLitres < currentLitres : candidate.volumeLitres > currentLitres)).sort((a, b) => (need === "smaller" ? b.volumeLitres - a.volumeLitres : a.volumeLitres - b.volumeLitres) || (a.id < b.id ? -1 : 1))
  return sorted[0]
}

/** The proposal's direction: a size where the catalogue sells one, else the frequency. */
export const directionOf = (need: "smaller" | "bigger", sized: boolean): RightSizingDirection => (need === "smaller" ? (sized ? "smaller" : "less-frequent") : sized ? "bigger" : "more-frequent")

/** Whether a direction is applied as a subscription change on approval; a frequency's is the office's own to make (#411, decision c). */
export const changesTheProduct = (direction: RightSizingDirection): boolean => direction === "smaller" || direction === "bigger"
