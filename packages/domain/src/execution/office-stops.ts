// The office's hand on a route's stops: a stop it adds (#111, O3, O3b and O11
// of #290) and the outcome it corrects. What each service's stop names is the
// pickup table's shapes, held at the boundary first so a body that breaks one
// is a 400 at its field rather than a failed write: a work order is of a
// container where it stands (`pickup_service_container_shape`), a delivery
// takes its place from its subscription, a bulky collection takes everything
// from its booking (`pickup_bulky_shape`), what a service books beside its
// container is its own and nothing else books it (`BOOKED_WITH`), and an
// emptying of no container is at one address with the fraction collected
// there. A correction's reason goes with a skip or a failure and a contaminant
// code with the wrong waste (`pickup_reason_shape`,
// `pickup_contaminant_code_shape`).
import { BOOKED_WITH, type BookedField } from "./work-orders"
import { PICKUP_SERVICES, pickupMissed, type PickupService } from "./vocabulary"

/** What a stop of each service takes its place and fraction from: its booking alone, its subscription, its container, or its container or one address. */
export const ADDED_STOP_PLACES = {
  empty: "container-or-address",
  deliver: "subscription",
  remove: "container",
  swap: "container",
  repair: "container",
  wash: "container",
  bulky: "booking",
} as const satisfies Record<PickupService, "booking" | "subscription" | "container" | "container-or-address">

/** The services whose stop may stand without a container: an emptying at an address, a bulky collection. */
export const CONTAINERLESS_SERVICES = PICKUP_SERVICES.filter((service) => ADDED_STOP_PLACES[service] === "booking" || ADDED_STOP_PLACES[service] === "container-or-address")

/** What a stop the office adds that names neither a container nor an address is told. */
export const A_CONTAINER_OR_AN_ADDRESS = "Name a container, or a property or a shared collection point with the waste fraction collected there"
/** What a container's stop naming a place or a fraction beside it is told: the placement gives both. */
export const THE_CONTAINER_ALONE = "A container's stop takes its place and fraction from the container's placement on the route's service date; name the container alone"
/** What an address-only stop naming two places is told. */
export const ONE_ADDRESS = "Name a property or a shared collection point, not both"
/** What an address-only stop without its fraction is told. */
export const AN_ADDRESS_WITH_ITS_FRACTION = "An address-only stop names the waste fraction collected there"
/** What a work order at an address alone is told. */
export const A_WORK_ORDER_OF_A_CONTAINER = "A work order is of a container: name the container"
/** What a delivery naming its place is told: the subscription says where. */
export const A_DELIVERY_AT_ITS_SUBSCRIPTION = "A delivery goes where its subscription serves: name the subscription, not the place"
/** What a bulky collection naming anything but its booking is told: the booking says where and what. */
export const THE_BOOKING_ALONE = "A bulky collection takes its place and fraction from its booking; name the booking alone"
/** What a bulky collection without its booking is told. */
export const A_BULKY_BOOKING = "A bulky collection names the bulky booking it collects"
/** What any other stop naming a booking is told. */
export const ONLY_A_BULKY_COLLECTION = "Only a bulky collection names a bulky booking"
/** What a swap of a container for itself is told. */
export const A_SWAP_FOR_ANOTHER = "A swap's replacement is another container"

/** What each ledger booking a service needs is told when it is missing (O3b of #290, `BOOKED_WITH`). */
export const BOOKS: Readonly<Record<BookedField, string>> = {
  subscriptionId: "A delivery names the subscription the container will serve under",
  warehouseId: "A removal or a swap names the warehouse the container goes back to",
  replacementContainerId: "A swap names the container that replaces it",
}
/** What a booking the service does not take is told. */
export const BOOKED_BY_NO_OTHER: Readonly<Record<BookedField, string>> = {
  subscriptionId: "Only a delivery names a subscription",
  warehouseId: "Only a removal or a swap names a warehouse",
  replacementContainerId: "Only a swap names a replacement",
}

export type AddedStopField = "containerId" | "propertyId" | "sharedCollectionPointId" | "wasteFractionId" | "bulkyBookingId" | BookedField

/** A stop as the office's body names it; a null counts as not given, as a form sends one for the field it leaves empty. */
export type AddedStop = { service?: string } & Partial<Record<AddedStopField, string | null>>

export type AddedStopIssue = { path: AddedStopField; message: string }

const PLACE_FIELDS = ["propertyId", "sharedCollectionPointId", "wasteFractionId"] as const
const BOOKED_FIELDS = ["subscriptionId", "replacementContainerId", "warehouseId"] as const

/** Every way the stop breaks its service's shape, each at its field, in the order a reader fixes them; none for a stop that will do. */
export function addedStopIssues(stop: AddedStop): AddedStopIssue[] {
  const issues: AddedStopIssue[] = []
  const given = (field: AddedStopField): boolean => stop[field] != null
  const service = (stop.service ?? "empty") as PickupService
  const placedBy = ADDED_STOP_PLACES[service]
  if (placedBy === "booking") {
    if (!given("bulkyBookingId")) issues.push({ path: "bulkyBookingId", message: A_BULKY_BOOKING })
    for (const path of ["containerId", ...PLACE_FIELDS, "subscriptionId", "warehouseId", "replacementContainerId"] as const) {
      if (given(path)) issues.push({ path, message: THE_BOOKING_ALONE })
    }
    return issues
  }
  if (given("bulkyBookingId")) issues.push({ path: "bulkyBookingId", message: ONLY_A_BULKY_COLLECTION })
  if (placedBy !== "container-or-address" && !given("containerId")) {
    issues.push({ path: "containerId", message: A_WORK_ORDER_OF_A_CONTAINER })
    return issues
  }
  const booked: readonly BookedField[] = BOOKED_WITH[service] ?? []
  for (const field of BOOKED_FIELDS) {
    if (booked.includes(field) && !given(field)) issues.push({ path: field, message: BOOKS[field] })
    if (!booked.includes(field) && given(field)) issues.push({ path: field, message: BOOKED_BY_NO_OTHER[field] })
  }
  if (booked.includes("replacementContainerId") && given("replacementContainerId") && stop.replacementContainerId === stop.containerId) {
    issues.push({ path: "replacementContainerId", message: A_SWAP_FOR_ANOTHER })
  }
  if (given("containerId")) {
    // A delivery takes its place from its subscription and may name its fraction; every other container's stop takes both from the placement.
    for (const path of PLACE_FIELDS) {
      if (!given(path) || (placedBy === "subscription" && path === "wasteFractionId")) continue
      issues.push({ path, message: placedBy === "subscription" ? A_DELIVERY_AT_ITS_SUBSCRIPTION : THE_CONTAINER_ALONE })
    }
    return issues
  }
  const places = [given("propertyId"), given("sharedCollectionPointId")].filter(Boolean).length
  if (places === 0) issues.push({ path: "containerId", message: A_CONTAINER_OR_AN_ADDRESS })
  else if (places > 1) issues.push({ path: "sharedCollectionPointId", message: ONE_ADDRESS })
  else if (!given("wasteFractionId")) issues.push({ path: "wasteFractionId", message: AN_ADDRESS_WITH_ITS_FRACTION })
  return issues
}

/** What a correction giving a reason with a completion, or none with a skip or a failure, is told. */
export const REASON_WITH_A_MISS = "Give a reason with skipped or failed, and none with completed"

/** A reason goes with a skip or a failure and not with a completion. */
export const reasonWithOutcome = (value: { outcome: string; reason?: string | null }): boolean => pickupMissed(value.outcome) === (value.reason != null)

/** What a code given with an outcome it does not tag is told (M5 of #293). */
export const CODE_WITH_CONTAMINATION = "A contaminant code goes with contamination, or with a collection made all the same"

/** A code tags the wrong waste: a stop missed for contamination, or one collected all the same. */
export const codeWithOutcome = (value: { outcome: string; reason?: string | null; contaminantCodeId?: string | null }): boolean =>
  value.contaminantCodeId == null || value.reason === "contamination" || value.outcome === "completed"
