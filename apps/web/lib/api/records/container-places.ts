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
// `placementShown`), so a record never shows one placement's subscription
// beside another's place. The period that placement serves it in under its
// subscription and that subscription's agreement — the three periods
// intersected, as the worker reads eligibility — rides on the record as
// `SERVING_PERIOD_KEY` with the project's day it was read on, which the rule
// preview judges on the scheme's first day where that is still ahead (#232),
// rather than the container's asset state. The map's readings — the point,
// `planningAreaId` and the facts — are today's: they are carried only while
// the period holds today. The areas are carried while the period has not
// ended, so a container whose placement starts with a new scheme is in its
// area's scope before it serves.
//
// This is a display derivation for the map and the preview. At generation
// the worker's PostGIS matcher (apps/worker/src/jobs/stop-matching.ts) is the
// truth: containment in the boundary in force on each service date, never a
// stored area. Where two areas of a project overlap, the point is in each,
// as the worker holds it to each scheme's own area; a point on a boundary's
// edge may read inside here and outside there, the boundary is the one in
// force today, and the preview judges one day where the worker judges each
// service date. A place not yet located has no point to contain, so its
// containers are named where they serve and stand nowhere on the map or in
// any area — the worker counts the same containers as `unlocated`.
import type { ContainerServicePlacement } from "@waste/contracts/containers"
import { planningAreaGeometry } from "@waste/domain/map-planning/areas"
import { pointInPolygon, type LngLat } from "@waste/domain/map-planning/geo"
import { SERVING_KEY, type ServingPeriod, type ServingReading } from "@waste/domain/route-schemes/matching"

import { AGREEMENT_PREFIX, AGREEMENTS_MODULE, isAgreementRecord, isSubscriptionRecord, PROPERTY_PREFIX, SHARED_POINT_PREFIX } from "@/lib/data/agreements"
import type { BusinessRecord, ModuleLocation } from "@/lib/data/business-modules"
import { MASTER_DATA_MODULE } from "@/lib/data/master-data"
import { PLANNING_AREAS_MODULE } from "@/lib/data/planning-areas"
import { isPropertyRecord, isSharedPointRecord, PROPERTIES_MODULE, SHARED_POINTS_MODULE } from "@/lib/data/properties"

import { typed, type MappingContext, type Resolver } from "./adapter"
import { dayIn, firstDayOut, planningAreaAdapter } from "./planning"
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

/** Whether a placement serves on the day: its period half-open, as the wire spells it. */
export const servesOn = (placement: ContainerServicePlacement, day: string) => placement.validFrom <= day && (placement.validTo === null || day < placement.validTo)

/** A half-open period: its first day, and its first day out or null while open. */
type Period = { from: string; until: string | null }

/** A record's period as the web's forms spell it — its end the last day in — half-open; undefined without a first day. */
function periodOf(record: BusinessRecord, fromKey: string, lastKey: string): Period | undefined {
  const from = typed(record, fromKey)
  if (from === undefined) return undefined
  const last = typed(record, lastKey)
  return { from, until: last === undefined ? null : firstDayOut(last) }
}

/** The days every period holds: the latest start to the earliest end; null where one is missing or they share none. */
function shared(periods: readonly (Period | undefined)[]): Period | null {
  const known = periods.filter((period): period is Period => period !== undefined)
  if (known.length < periods.length) return null
  const from = known.map((period) => period.from).sort().at(-1)
  const until = known.flatMap((period) => (period.until === null ? [] : [period.until])).sort()[0] ?? null
  return from === undefined || (until !== null && until <= from) ? null : { from, until }
}

const covers = (period: Period, day: string) => period.from <= day && (period.until === null || day < period.until)

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

/** A placement read through: its subscription's agreement, its place, and the period the three share (null where they share none); undefined where a link is not loaded. */
type Chain = { agreement: BusinessRecord; property: BusinessRecord | undefined; place: BusinessRecord | undefined; period: Period | null }

function chainOf(placement: ContainerServicePlacement, context: MappingContext): Chain | undefined {
  const subscription = context.resolve.byServerId(placement.subscriptionId)
  if (subscription === undefined || !isSubscriptionRecord(subscription)) return undefined
  const agreement = placeRecord(typed(subscription, "agreementId"), AGREEMENT_PREFIX, isAgreementRecord, context)
  if (agreement === undefined) return undefined
  const property = placeRecord(typed(subscription, "propertyId"), PROPERTY_PREFIX, isPropertyRecord, context)
  const point = property === undefined ? placeRecord(typed(subscription, "sharedPointId"), SHARED_POINT_PREFIX, isSharedPointRecord, context) : undefined
  const period = shared([{ from: placement.validFrom, until: placement.validTo }, periodOf(subscription, "validFrom", "validTo"), periodOf(agreement, "effectiveFrom", "effectiveTo")])
  return { agreement, property, place: property ?? point, period }
}

/** The point a place is located at, or undefined while it is not. */
function pointOf(place: BusinessRecord): { latitude: string; longitude: string; at: LngLat } | undefined {
  const latitude = typed(place, "latitude")
  const longitude = typed(place, "longitude")
  return latitude === undefined || longitude === undefined ? undefined : { latitude, longitude, at: { lng: Number(longitude), lat: Number(latitude) } }
}

/** The planning areas of the project whose boundary in force contains the point, in load order. */
function areasAt(at: LngLat, projectWebId: string, context: MappingContext): BusinessRecord[] {
  return loadedAreas(context.resolve)
    .filter((loaded) => (loaded.area.projectIds?.includes(projectWebId) ?? false) && contains(loaded, at))
    .map((loaded) => loaded.area)
}

/**
 * Where and when a container serves, as its record carries it.
 * `SERVING_KEY`: for each of its placements not ended by the project's day,
 * the period it serves the container in under its subscription and that
 * subscription's agreement, with the planning areas its place lies in, read
 * on that day — the rule preview judges a scheme on the period that holds on
 * its first day (#232). The map's readings are the placement the record shows
 * (`shown`) while it serves today: the point, `planningAreaId` and the facts;
 * only the name for a place not yet located, and where and from when for one
 * that serves later. `projectWebId` scopes the planning areas: an area is its
 * project's, so another project's outline over the same street is not the
 * container's.
 */
export function containerPlace(shown: ContainerServicePlacement | undefined, placements: readonly ContainerServicePlacement[], projectWebId: string, timezone: string | undefined, context: MappingContext): ContainerPlace {
  const day = dayIn(context.now ?? new Date(), timezone)
  const periods: ServingPeriod[] = placements.flatMap((placement) => {
    const chain = chainOf(placement, context)
    if (chain?.period == null || (chain.period.until !== null && chain.period.until <= day)) return []
    const point = chain.place === undefined ? undefined : pointOf(chain.place)
    return [{ ...chain.period, areaIds: point === undefined ? [] : areasAt(point.at, projectWebId, context).map((area) => area.id) }]
  })
  const values = { [SERVING_KEY]: JSON.stringify({ asOf: day, periods } satisfies ServingReading) }
  const chain = shown === undefined ? undefined : chainOf(shown, context)
  if (chain?.place === undefined || chain.period === null) return { facts: {}, values }
  const { agreement, property, place, period } = chain
  const address = typed(place, property === undefined ? "address" : "serviceAddress")
  if (!covers(period, day)) {
    // Serving later: where and from when, for the preview's matched rows; the map's readings are today's.
    return { facts: period.from > day ? { "Serves at": `${place.name}${address === undefined ? "" : `, ${address}`} — from ${period.from}` } : {}, values }
  }
  const point = pointOf(place)
  if (point === undefined) return { facts: { "Serves at": `${place.name}, not located yet` }, values }
  const { latitude, longitude } = point
  const areas = areasAt(point.at, projectWebId, context)
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
    values: { latitude, longitude, ...values, ...(areas.length === 0 ? {} : { planningAreaId: areas[0].id }) },
  }
}
