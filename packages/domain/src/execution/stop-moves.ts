// Moving stops between routes, splitting a route and merging two (O23 of
// #290, #358). Pure, so the API's three commands and the web's dialogs judge
// a move by one rule.
//
// A stop never changes its route: its proofs, its ticket's booking and the
// keys that name it carry the route beside it. A move is the stop taken off
// where it stood — `skipped · removed-by-dispatcher`, its note naming where it
// went (`movedTo`) — and the office's own stop of the same work put on the
// other route (`origin = office`), judged there as the office's Add stop
// judges one. That is what makes a move survive the next generation run with
// nothing new to hold: a refresh never brings back a stop the dispatcher took
// off (only its own `regeneration` skips), and never skips, moves or doubles
// the office's (`pickupChanges`, ../planning/generation.ts).
//
// Only open stops move, of a route that has not started, onto one that has
// not either — the rule Add stop and remove hold (`orderIsOpen`). An emptying
// does not move onto a route that empties the container already: the two
// would be one collection told twice, and the office's would read as an extra
// emptying (`extraEmptyings`, ./services.ts), which is charged.
import { count } from "../text"
import { empties } from "./services"
import type { PickupService, PickupStatus } from "./vocabulary"

/** A stop as a move reads it: on the route it leaves, or on the route it joins. */
export type MovingStop = { id: string; position: number; status: PickupStatus; containerId: string | null; service: PickupService }

/** The note a stop moved off its route carries: where it went. */
export const movedTo = (route: string): string => `Moved to route ${route}`

/** The free reason a merged route is cancelled with, beside the `merged` code. */
export const mergedInto = (route: string): string => `Merged into route ${route}`

/** What a move naming the route the stops are on is told, at `toRouteId` or `routeId`. */
export const ANOTHER_ROUTE = "Name another route: the stops are on this one"

/** What a move or a merge naming a route of another project is told: a stop stays in its project. */
export const NOT_A_ROUTE_OF_THE_PROJECT = "Not a route of this route's project"

/** What a body naming ids that are not open stops of the route is told, at `pickupIds`. */
export const notOpenStopsOf = (strangers: number, route: string): string => `${count(strangers, "id")} not an open stop of route ${route}`

/** What a split naming every open stop of the route is told, at `pickupIds`: the route would be left with none. */
export const splitLeavesNone = (route: string): string => `A split leaves route ${route} some of its open stops; move them all to another route instead`

/** What an emptying moved onto a route that empties its container already is told. */
export const emptiedThereAlready = (container: string, route: string): string => `Route ${route} empties container ${container} already; take one of the two stops off instead`

/** The named ids that are not open stops of the route, in the body's order: what the 400 counts. */
export function strangersAmong(named: readonly string[], stops: readonly MovingStop[]): string[] {
  const open = new Set(stops.filter((stop) => stop.status === "planned").map((stop) => stop.id))
  return named.filter((id) => !open.has(id))
}

/** The stops a move takes, in the order they stand on the route — by position, then by id — whatever the body's order. */
export function movingInOrder(named: readonly string[], stops: readonly MovingStop[]): MovingStop[] {
  const wanted = new Set(named)
  return stops.filter((stop) => wanted.has(stop.id) && stop.status === "planned").sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Every open stop of the route, in its order: what a merge moves. */
export const openStopsInOrder = (stops: readonly MovingStop[]): MovingStop[] =>
  movingInOrder(
    stops.map((stop) => stop.id),
    stops,
  )

/** Whether a split names every open stop of its route, leaving it none. */
export const leavesNoStop = (named: readonly string[], stops: readonly MovingStop[]): boolean => stops.some((stop) => stop.status === "planned") && movingInOrder(named, stops).length === stops.filter((stop) => stop.status === "planned").length

/** Whether the route a stop joins empties the stop's container already, with a planned emptying of either origin: refused for an emptying, since the two would be one collection. */
export function emptiedAlready(stop: MovingStop, onTarget: readonly MovingStop[]): boolean {
  if (stop.containerId === null || !empties(stop)) return false
  return onTarget.some((other) => other.status === "planned" && other.containerId === stop.containerId && empties(other))
}
