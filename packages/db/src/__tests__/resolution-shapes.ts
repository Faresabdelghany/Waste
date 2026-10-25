// The ticket's spellings 0035 (O3c of #290) gave it, which
// resolution-rendering and ticket-stops-rendering both read: the booked
// stop's shape, its key through the route, its one-ticket-per-stop index and
// the route's index.
import { foreignKey, index, partialUniqueIndex, ref } from "./rendering"

/** The booked stop and its route together or not at all. */
export const BOOKED_SHAPE = `(${ref("ticket", "booked_route_id")} is null) = (${ref("ticket", "booked_pickup_id")} is null)`

/** The booked stop is a stop of its route: the key carries the route on both sides, as the re-collection's does. */
export const BOOKED_PICKUP_FK = foreignKey("ticket", "ticket_booked_route_id_booked_pickup_id_fk", ["company_id", "project_id", "booked_route_id", "booked_pickup_id"], "pickup", ["company_id", "project_id", "route_id", "id"])
/** A stop answers one ticket. */
export const BOOKED_PICKUP_KEY = partialUniqueIndex("ticket", "ticket_booked_pickup_id_key", ["company_id", "booked_pickup_id"], `${ref("ticket", "booked_pickup_id")} is not null`)
export const BOOKED_ROUTE_INDEX = index("ticket", "ticket_booked_route_id_idx", "company_id", "booked_route_id")
