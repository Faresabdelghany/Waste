// What a stop is for, beyond the vocabulary (O3 of #290): which of the
// office's emptyings is an extra one. One rule, read by the Driver App's card
// and by anything else that tells an extra emptying from a collection, so
// the two never disagree.
import type { PickupOrigin, PickupReason, PickupService, PickupStatus } from "./vocabulary"

/** A stop as the rule reads it; `service` absent on one read from before the service, which emptied its container. */
export type ServiceStop = { id: string; containerId: string | null; origin: PickupOrigin; service?: PickupService; status: PickupStatus; reason: PickupReason | null }

/** The reasons a generation stop left its route by without being visited: the dispatcher took it off, or the plan no longer holds it. */
const TAKEN_OFF: ReadonlySet<PickupReason> = new Set(["removed-by-dispatcher", "regeneration"])

/** Whether a stop empties its container: an emptying, or a stop read from before the service. */
export const empties = (stop: Pick<ServiceStop, "service">): boolean => (stop.service ?? "empty") === "empty"

/**
 * The office's emptyings that are a second visit: an office emptying of a
 * container that one of generation's emptyings on the route visits as well,
 * leaving aside one the dispatcher took off or the plan dropped. Any other
 * office emptying is its container's collection on the route — generation's
 * refresh stands it for the plan's (`pickupChanges`) — and a work order
 * empties nothing.
 */
export function extraEmptyings(stops: readonly ServiceStop[]): ReadonlySet<string> {
  const visited = (stop: ServiceStop) => !(stop.status === "skipped" && stop.reason !== null && TAKEN_OFF.has(stop.reason))
  const planned = new Set(stops.filter((stop) => stop.origin === "generation" && stop.containerId !== null && empties(stop) && visited(stop)).map((stop) => stop.containerId))
  return new Set(stops.filter((stop) => stop.origin === "office" && stop.containerId !== null && empties(stop) && planned.has(stop.containerId)).map((stop) => stop.id))
}
