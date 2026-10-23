// Where a server container stands (Issue #184, slice 9b of #81). A container
// carries no location on the wire: its placement names a subscription, the
// subscription a property or a shared collection point, and the place its
// point. So the container's record reads that chain through the store's
// resolver — the agreements and their subscriptions, the properties and the
// points load before the containers — and carries the place as the
// fixtures' containers carry theirs: the point as typed `latitude`/
// `longitude`, the name (`Property` or `Shared collection point`), the
// `Address`, the `Property type` and the `Agreement` as facts, and every
// planning area of its project whose boundary in force contains the point
// under `PLANNING_AREA_IDS_KEY`, their names as the `Planning area` fact. The
// map places a record by exactly those, its statistics and filters read the
// facts, and the collection groups' rule preview scopes one by its areas
// (#207).
//
// The place is the one of the placement the record shows (containers.ts,
// `placementShown`), and only while it serves on the project's day under a
// subscription and an agreement in force that day — the period three times
// over, as the worker reads eligibility — so a record never shows one
// placement's subscription beside another's place. Whether it serves so is
// `SERVES_TODAY_KEY`, `"yes"` or `"no"`, which the preview holds a container
// to rather than its asset state (#207).
//
// This is a display derivation for the map and the preview. At generation
// the worker's PostGIS matcher (apps/worker/src/jobs/stop-matching.ts) is the
// truth: containment in the boundary in force on each service date, never a
// stored area. Where two areas of a project overlap, the point is in each,
// as the worker holds it to each scheme's own area; a point on a boundary's
// edge may read inside here and outside there, and the preview's day is
// today, where the worker's is each service date. A place not yet located
// has no point to contain, so its containers serve today, are named where
// they serve and stand nowhere on the map or in any area — the worker counts
// the same containers as `unlocated`.
import type { ContainerServicePlacement } from "@waste/contracts/containers"
import { planningAreaGeometry } from "@waste/domain/map-planning/areas"
import { pointInPolygon, type LngLat } from "@waste/domain/map-planning/geo"
import { PLANNING_AREA_IDS_KEY, SERVES_TODAY_KEY } from "@waste/domain/route-schemes/matching"

import { AGREEMENT_PREFIX, isAgreementRecord, isSubscriptionRecord, PROPERTY_PREFIX, SHARED_POINT_PREFIX } from "@/lib/data/agreements"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { isPropertyRecord, isSharedPointRecord } from "@/lib/data/properties"

import { typed, type MappingContext } from "./adapter"
import { dayIn, planningAreaAdapter } from "./planning"
import { referencedServerId } from "./references"

/** What a placed container adds to its record: facts, and typed values. */
export type ContainerPlace = { facts: Record<string, string>; values: Record<string, string> }

const NOWHERE: ContainerPlace = { facts: {}, values: { [SERVES_TODAY_KEY]: "no" } }
const SERVES = { [SERVES_TODAY_KEY]: "yes" }

/** Whether a placement serves on the day: its period half-open, as the wire spells it. */
const servesOn = (placement: ContainerServicePlacement, day: string) => placement.validFrom <= day && (placement.validTo === null || day < placement.validTo)

/** Whether a record's period is in force on the day, its end the last day in as the web's forms spell it. */
function inForceOn(record: BusinessRecord, fromKey: string, lastKey: string, day: string): boolean {
  const from = typed(record, fromKey)
  const last = typed(record, lastKey)
  return from !== undefined && from <= day && (last === undefined || day <= last)
}

/** The loaded row a web id names, held to its kind. */
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
 * carries it: the place of `placement` — the one the record shows — while it,
 * its subscription and that subscription's agreement are in force that day;
 * nothing otherwise, and only the name for a place not yet located.
 * `projectWebId` scopes the planning areas: an area is its project's, so
 * another project's outline over the same street is not the container's.
 */
export function containerPlace(placement: ContainerServicePlacement | undefined, projectWebId: string, timezone: string | undefined, context: MappingContext): ContainerPlace {
  const day = dayIn(context.now ?? new Date(), timezone)
  if (placement === undefined || !servesOn(placement, day)) return NOWHERE
  const subscription = context.resolve.byServerId(placement.subscriptionId)
  if (subscription === undefined || !isSubscriptionRecord(subscription) || !inForceOn(subscription, "validFrom", "validTo", day)) return NOWHERE
  const agreement = placeRecord(typed(subscription, "agreementId"), AGREEMENT_PREFIX, isAgreementRecord, context)
  if (agreement === undefined || !inForceOn(agreement, "effectiveFrom", "effectiveTo", day)) return NOWHERE
  const property = placeRecord(typed(subscription, "propertyId"), PROPERTY_PREFIX, isPropertyRecord, context)
  const point = property === undefined ? placeRecord(typed(subscription, "sharedPointId"), SHARED_POINT_PREFIX, isSharedPointRecord, context) : undefined
  const place = property ?? point
  if (place === undefined) return NOWHERE
  const latitude = typed(place, "latitude")
  const longitude = typed(place, "longitude")
  if (latitude === undefined || longitude === undefined) return { facts: { "Serves at": `${place.name}, not located yet` }, values: SERVES }
  const at: LngLat = { lng: Number(longitude), lat: Number(latitude) }
  const areas = context.resolve.filter((record) => planningAreaAdapter.owns(record) && (record.projectIds?.includes(projectWebId) ?? false) && contains(record, at))
  const address = typed(place, property === undefined ? "address" : "serviceAddress")
  const kind = property?.facts["Property type"]
  return {
    facts: {
      [property === undefined ? "Shared collection point" : "Property"]: place.name,
      ...(address === undefined ? {} : { Address: address }),
      ...(kind === undefined ? {} : { "Property type": kind }),
      // As the fixtures spell it, which the Selected area's count of active agreements reads.
      Agreement: `${typed(agreement, "agreementNumber") ?? agreement.name} · ${agreement.status.toLowerCase()}`,
      ...(areas.length === 0 ? {} : { "Planning area": areas.map((area) => area.name).join(", ") }),
    },
    values: { latitude, longitude, ...SERVES, ...(areas.length === 0 ? {} : { [PLANNING_AREA_IDS_KEY]: areas.map((area) => area.id).join(",") }) },
  }
}
