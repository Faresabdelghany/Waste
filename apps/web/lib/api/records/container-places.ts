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
import { PLANNING_AREA_IDS_KEY, SERVING_PERIOD_KEY, type ServingPeriod } from "@waste/domain/route-schemes/matching"

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

/** The days every period holds, read on `asOf`: the latest start to the earliest end; serving no day where one is missing or they share none. */
function servingPeriod(periods: readonly (Period | undefined)[], asOf: string): ServingPeriod {
  const known = periods.filter((period): period is Period => period !== undefined)
  if (known.length < periods.length) return { from: null, until: null, asOf }
  const from = known.map((period) => period.from).sort().at(-1) ?? null
  const until = known.flatMap((period) => (period.until === null ? [] : [period.until])).sort()[0] ?? null
  return from === null || (until !== null && until <= from) ? { from: null, until: null, asOf } : { from, until, asOf }
}

const holds = (period: ServingPeriod, day: string) => period.from !== null && period.from <= day && (period.until === null || day < period.until)
const ended = (period: ServingPeriod) => period.from === null || (period.until !== null && period.until <= period.asOf)
const serving = (period: ServingPeriod) => ({ [SERVING_PERIOD_KEY]: JSON.stringify(period) })

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
 * The place a container serves at, as its record carries it: the place of
 * `placement` — the one the record shows — and the period it serves there
 * under its subscription and that subscription's agreement, read on the
 * project's day. The areas while that period has not ended; the point, the
 * map's area and the facts while it holds today, and only the name for a
 * place not yet located. `projectWebId` scopes the planning areas: an area is
 * its project's, so another project's outline over the same street is not
 * the container's.
 */
export function containerPlace(placement: ContainerServicePlacement | undefined, projectWebId: string, timezone: string | undefined, context: MappingContext): ContainerPlace {
  const day = dayIn(context.now ?? new Date(), timezone)
  const nowhere: ContainerPlace = { facts: {}, values: serving({ from: null, until: null, asOf: day }) }
  if (placement === undefined) return nowhere
  const subscription = context.resolve.byServerId(placement.subscriptionId)
  if (subscription === undefined || !isSubscriptionRecord(subscription)) return nowhere
  const agreement = placeRecord(typed(subscription, "agreementId"), AGREEMENT_PREFIX, isAgreementRecord, context)
  if (agreement === undefined) return nowhere
  const period = servingPeriod([{ from: placement.validFrom, until: placement.validTo }, periodOf(subscription, "validFrom", "validTo"), periodOf(agreement, "effectiveFrom", "effectiveTo")], day)
  const today = holds(period, day)
  const property = placeRecord(typed(subscription, "propertyId"), PROPERTY_PREFIX, isPropertyRecord, context)
  const point = property === undefined ? placeRecord(typed(subscription, "sharedPointId"), SHARED_POINT_PREFIX, isSharedPointRecord, context) : undefined
  const place = property ?? point
  if (place === undefined) return { facts: {}, values: serving(period) }
  const latitude = typed(place, "latitude")
  const longitude = typed(place, "longitude")
  if (latitude === undefined || longitude === undefined) return { facts: today ? { "Serves at": `${place.name}, not located yet` } : {}, values: serving(period) }
  const at: LngLat = { lng: Number(longitude), lat: Number(latitude) }
  const areas = ended(period)
    ? []
    : loadedAreas(context.resolve)
        .filter((loaded) => (loaded.area.projectIds?.includes(projectWebId) ?? false) && contains(loaded, at))
        .map((loaded) => loaded.area)
  const areaIds: Record<string, string> = areas.length === 0 ? {} : { [PLANNING_AREA_IDS_KEY]: areas.map((area) => area.id).join(",") }
  // A placement that serves later is in its areas' scope for a scheme that starts then; the map shows today's.
  if (!today) return { facts: {}, values: { ...serving(period), ...areaIds } }
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
    values: { latitude, longitude, ...serving(period), ...(areas.length === 0 ? {} : { planningAreaId: areas[0].id }), ...areaIds },
  }
}
