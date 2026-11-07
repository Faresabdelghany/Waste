// A place that still serves (Issue #79: a status gates a new reference and
// never an existing one). A subscription is made at a place, a container is
// placed at one through its subscription or as a public placement, a stop is
// added at an address and a bulky booking is made at one: each needs the
// place served — a Property active, a Shared Collection Point open or
// restricted. One definition, so a point a subscription may not be made at is
// a point a container may not be placed at and a stop may not be added at
// either, drafted again or closed alike. The refusal is a conflict naming the
// status the place has and what the reference needs: the id is right and the
// row is there, and what refuses is the state it is in.
import { Refused } from "../refusal"
import { takesReference } from "../status-gates"
import { SERVED_PROPERTY_STATUSES, SERVING_POINT_STATUSES, type PropertyStatus, type SharedCollectionPointStatus } from "./vocabulary"

/** How many places a body names: a property and a shared collection point, a null or absent id naming neither. Each context says how many it takes, and in its own words. */
export const placesNamed = (body: { propertyId?: string | null; sharedCollectionPointId?: string | null }): number => [body.propertyId, body.sharedCollectionPointId].filter((place) => place != null).length

/** The place a reference is made at, as the statuses of its two possible rows: one is null, since a reference names one place. */
export type Place = { propertyStatus: PropertyStatus | null; sharedCollectionPointStatus: SharedCollectionPointStatus | null }

/** A place as two lookups answer it, an id not named being a row not there. */
export const placeOf = (propertyStatus: PropertyStatus | undefined, sharedCollectionPointStatus: SharedCollectionPointStatus | undefined): Place => ({
  propertyStatus: propertyStatus ?? null,
  sharedCollectionPointStatus: sharedCollectionPointStatus ?? null,
})

/** What names the place, and how its sentence begins: a placement reaches it through its subscription, the others name it themselves. */
export type PlaceReference = "subscription" | "placement" | "public placement" | "stop" | "booking"
const PLACE_OF: Readonly<Record<PlaceReference, string>> = { subscription: "The", placement: "The subscription's", "public placement": "The", stop: "The", booking: "The" }

/** The place a reference is made at: served, or a conflict naming the status it has and what the reference needs. */
export function refuseUnservedPlace(place: Place, reference: PlaceReference): void {
  const { propertyStatus, sharedCollectionPointStatus } = place
  if (propertyStatus !== null && !takesReference(propertyStatus, SERVED_PROPERTY_STATUSES)) {
    throw Refused.conflict(`${PLACE_OF[reference]} property is ${propertyStatus}; a ${reference} needs an active property`)
  }
  if (sharedCollectionPointStatus !== null && !takesReference(sharedCollectionPointStatus, SERVING_POINT_STATUSES)) {
    throw Refused.conflict(`${PLACE_OF[reference]} shared collection point is ${sharedCollectionPointStatus}; a ${reference} needs an open or restricted point`)
  }
}
