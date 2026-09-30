// Where a server container stands (Issue #184, slice 9b of #81). A container
// carries no location on the wire: its placement names a subscription, the
// subscription a property or a shared collection point, and the place its
// point. So the container's record reads that chain through the store's
// resolver — the subscriptions, the properties and the points load before
// the containers — for the placement in force on its project's day, and
// carries the place as the fixtures' containers carry theirs: the point as
// typed `latitude`/`longitude`, the name (`Property` or `Shared collection
// point`) and the `Address` as facts, and the planning area whose boundary in
// force contains the point as `planningAreaId`. The map places a record by
// exactly those, and the collection groups' rule preview scopes one by its
// area.
//
// This is a display derivation for the map and the preview. At generation
// the worker's PostGIS matcher (apps/worker/src/jobs/stop-matching.ts) is the
// truth: containment in the boundary in force on each service date, never a
// stored area. A place not yet located has no point to contain, so its
// containers are named where they serve and stand nowhere on the map — the
// worker counts the same containers as `unlocated`.
import type { ContainerServicePlacement } from "@waste/contracts/containers"
import { planningAreaGeometry } from "@waste/domain/map-planning/areas"
import { pointInPolygon, type LngLat } from "@waste/domain/map-planning/geo"

import { isSubscriptionRecord, PROPERTY_PREFIX, SHARED_POINT_PREFIX } from "@/lib/data/agreements"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { isPropertyRecord, isSharedPointRecord } from "@/lib/data/properties"

import { typed, type MappingContext } from "./adapter"
import { dayIn, planningAreaAdapter } from "./planning"
import { referencedServerId } from "./references"

/** What a placed container adds to its record: facts, and typed values. */
export type ContainerPlace = { facts: Record<string, string>; values: Record<string, string> }

const NOWHERE: ContainerPlace = { facts: {}, values: {} }

/** The placement in force on the day, half-open: at most one, since a container serves in one place at a time. */
export const placementInForce = (placements: readonly ContainerServicePlacement[], day: string): ContainerServicePlacement | undefined =>
  placements.find((placement) => placement.validFrom <= day && (placement.validTo === null || day < placement.validTo))

/** The loaded row a subscription names its place by, held to its kind. */
function placeRecord(webId: string | undefined, prefix: string, owns: (record: BusinessRecord) => boolean, context: MappingContext): BusinessRecord | undefined {
  if (webId === undefined) return undefined
  const serverId = referencedServerId(webId, prefix, context, { owns })
  return serverId === undefined ? undefined : context.resolve.byServerId(serverId)
}

/** Whether the area's boundary in force contains the point: inside its outer ring and inside none of its holes. */
function contains(area: BusinessRecord, at: LngLat): boolean {
  const geometry = planningAreaGeometry(area)
  if (geometry === null) return false
  const [outer, ...holes] = geometry.coordinates.map((ring) => ring.map(([lng, lat]) => ({ lng, lat })))
  return pointInPolygon(at, outer) && !holes.some((hole) => pointInPolygon(at, hole))
}

/**
 * The place a container serves at on its project's day, as its record
 * carries it; nothing for a container serving nowhere that day, and only the
 * name for a place not yet located. `projectWebId` scopes the planning area:
 * an area is its project's, so another project's outline over the same
 * street is not the container's.
 */
export function containerPlace(placements: readonly ContainerServicePlacement[], projectWebId: string, timezone: string | undefined, context: MappingContext): ContainerPlace {
  const placement = placementInForce(placements, dayIn(context.now ?? new Date(), timezone))
  if (placement === undefined) return NOWHERE
  const subscription = context.resolve.byServerId(placement.subscriptionId)
  if (subscription === undefined || !isSubscriptionRecord(subscription)) return NOWHERE
  const property = placeRecord(typed(subscription, "propertyId"), PROPERTY_PREFIX, isPropertyRecord, context)
  const point = property === undefined ? placeRecord(typed(subscription, "sharedPointId"), SHARED_POINT_PREFIX, isSharedPointRecord, context) : undefined
  const place = property ?? point
  if (place === undefined) return NOWHERE
  const latitude = typed(place, "latitude")
  const longitude = typed(place, "longitude")
  if (latitude === undefined || longitude === undefined) return { facts: { "Serves at": `${place.name}, not located yet` }, values: {} }
  const at: LngLat = { lng: Number(longitude), lat: Number(latitude) }
  const area = context.resolve.find((record) => planningAreaAdapter.owns(record) && (record.projectIds?.includes(projectWebId) ?? false) && contains(record, at))
  const address = typed(place, property === undefined ? "address" : "serviceAddress")
  return {
    facts: {
      [property === undefined ? "Shared collection point" : "Property"]: place.name,
      ...(address === undefined ? {} : { Address: address }),
      ...(area === undefined ? {} : { "Planning area": area.name }),
    },
    values: { latitude, longitude, ...(area === undefined ? {} : { planningAreaId: area.id }) },
  }
}
