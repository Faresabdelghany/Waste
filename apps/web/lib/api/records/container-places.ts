// Where a server container stands (Issue #184, slice 9b of #81). A container
// carries no location on the wire: its placement names a subscription, the
// subscription a property or a shared collection point, and the place its
// point. So the container's record reads that chain through the store's
// resolver — the agreements and their subscriptions, the properties and the
// points load before the containers — and carries the place as the
// fixtures' containers carry theirs: the point as typed `latitude`/
// `longitude`, the name (`Property` or `Shared collection point`), the
// `Address`, the `Property type` and the `Agreement` as facts, and the
// planning areas of its project whose boundary in force contains the point:
// every one under `PLANNING_AREA_IDS_KEY`, which the collection groups' rule
// preview scopes it by (#207), and the first, in load order, as
// `planningAreaId` and the `Planning area` fact, the one area the map's
// readers take. The map places a record by exactly those, and its statistics
// and filters read the facts.
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

import { AGREEMENT_PREFIX, AGREEMENTS_MODULE, isAgreementRecord, isSubscriptionRecord, PROPERTY_PREFIX, SHARED_POINT_PREFIX } from "@/lib/data/agreements"
import type { BusinessRecord, ModuleLocation } from "@/lib/data/business-modules"
import { MASTER_DATA_MODULE } from "@/lib/data/master-data"
import { PLANNING_AREAS_MODULE } from "@/lib/data/planning-areas"
import { isPropertyRecord, isSharedPointRecord, PROPERTIES_MODULE, SHARED_POINTS_MODULE } from "@/lib/data/properties"

import { typed, type MappingContext, type Resolver } from "./adapter"
import { dayIn, planningAreaAdapter } from "./planning"
import { referencedServerId } from "./references"

/**
 * The switched modules a container's record is read through beside its own:
 * the agreements and their subscriptions, the properties and the shared
 * points its place is, the planning areas containing it, and the master data
 * naming its fraction and type. They load before the containers; until every
 * one is ready a container may stand nowhere because its place is unread, not
 * because it serves nowhere, so the preview's zero match is no evidence then
 * (lib/data/route-schemes.ts, `containersPlaced`, #207).
 */
export const CONTAINER_PLACE_MODULES: readonly ModuleLocation[] = [AGREEMENTS_MODULE, PROPERTIES_MODULE, SHARED_POINTS_MODULE, PLANNING_AREAS_MODULE, MASTER_DATA_MODULE]

/** What a placed container adds to its record: facts, and typed values. */
export type ContainerPlace = { facts: Record<string, string>; values: Record<string, string> }

const NOWHERE: ContainerPlace = { facts: {}, values: { [SERVES_TODAY_KEY]: "no" } }
const SERVES = { [SERVES_TODAY_KEY]: "yes" }

/** Whether a placement serves on the day: its period half-open, as the wire spells it. */
export const servesOn = (placement: ContainerServicePlacement, day: string) => placement.validFrom <= day && (placement.validTo === null || day < placement.validTo)

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

/** A loaded planning area with its boundary in force as rings: its outer ring first, then its holes. */
type LoadedArea = { area: BusinessRecord; rings: LngLat[][] }

/** The planning areas a mapping pass reads, with their boundaries parsed: once per resolver, not once per container. */
const areasUnder = new WeakMap<Resolver, readonly LoadedArea[]>()

function loadedAreas(resolve: Resolver): readonly LoadedArea[] {
  let areas = areasUnder.get(resolve)
  if (areas === undefined) {
    areas = resolve.filter(planningAreaAdapter.owns).flatMap((area) => {
      const geometry = planningAreaGeometry(area)
      return geometry === null ? [] : [{ area, rings: geometry.coordinates.map((ring) => ring.map(([lng, lat]) => ({ lng, lat }))) }]
    })
    areasUnder.set(resolve, areas)
  }
  return areas
}

/** Whether the boundary contains the point: inside its outer ring and inside none of its holes. */
function contains({ rings: [outer, ...holes] }: LoadedArea, at: LngLat): boolean {
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
  const areas = loadedAreas(context.resolve)
    .filter((loaded) => (loaded.area.projectIds?.includes(projectWebId) ?? false) && contains(loaded, at))
    .map((loaded) => loaded.area)
  const address = typed(place, property === undefined ? "address" : "serviceAddress")
  const kind = property?.facts["Property type"]
  return {
    facts: {
      [property === undefined ? "Shared collection point" : "Property"]: place.name,
      ...(address === undefined ? {} : { Address: address }),
      ...(kind === undefined ? {} : { "Property type": kind }),
      // As the fixtures spell it, which the Selected area's count of active agreements reads.
      Agreement: `${typed(agreement, "agreementNumber") ?? agreement.name} · ${agreement.status.toLowerCase()}`,
      ...(areas.length === 0 ? {} : { "Planning area": areas[0].name }),
    },
    values: { latitude, longitude, ...SERVES, ...(areas.length === 0 ? {} : { planningAreaId: areas[0].id, [PLANNING_AREA_IDS_KEY]: areas.map((area) => area.id).join(",") }) },
  }
}
