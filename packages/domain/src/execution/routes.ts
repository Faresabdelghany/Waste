// What a request about routes keeps to (Issue #104, O5 and O23 of #290): a
// route's label is its number under its prefix (../numbering); a bulk
// dispatch names each route once and at most fifty, each a savepoint of the
// request's transaction, below the 64 subtransactions Postgres caches per
// transaction, as the CSV import's batch; a stop order names each open stop
// once, and a day's route of any length fits it. A stop is driven in its
// active Plan's `sequence` where it has one, its generated `position`
// otherwise.
import { eachOnceSentence } from "../requests"

/** What a route whose label is not its number is told. */
export const LABEL_IS_THE_NUMBER = "label is the number under the route prefix"

/** The most routes one bulk dispatch names; a larger day goes in several. */
export const DISPATCH_MANY_MAX = 50

/** What a bulk dispatch naming a route twice is told. */
export const EACH_ROUTE_ONCE = eachOnceSentence("route", "a route is dispatched once")

/** The most pickups an order may name: a day's route has tens, a long one hundreds, and five hundred is room for any. */
export const PICKUP_ORDER_MAX = 500

/** What an order naming a stop twice is told. */
export const EACH_PICKUP_ONCE = eachOnceSentence("pickup", "a stop has one place in the order")

/** A stop's place in the order: its `sequence` where it has one, its `position` otherwise. */
export const stopNumber = (stop: { readonly position: number; readonly sequence?: number | null }): number => stop.sequence ?? stop.position

/** The stops in the order they are driven, a tie broken by position. */
export function stopsInOrder<Stop extends { readonly position: number; readonly sequence?: number | null }>(stops: readonly Stop[]): Stop[] {
  return [...stops].sort((a, b) => stopNumber(a) - stopNumber(b) || a.position - b.position)
}
