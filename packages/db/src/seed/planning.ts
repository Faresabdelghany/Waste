// Planning's demo rows (Issue #156, decided in #143): what `pnpm db:seed`
// writes of the pilot's planning configuration, copied from the web
// prototype's fixtures (`apps/web/lib/data/business-modules.ts`: the `plan`
// workspace's schemes and calendars, the `configure` workspace's areas)
// under registry.ts's discipline — literal copies, fixed ids keyed by the
// prototype's record ids, and every reading stated here. Configuration only:
// no Route, Pickup or generation run is written; generating is the running
// Pilot's (#143).
//
//   Areas. The five planning areas at their fixtures' Code facts, each a
//   `route-planning` area, as its context ("Planning area · …") reads.
//
//   Boundaries. Derived, not authored: the outline the prototype's map draws
//   around an area (`planningAreaOutline`, @waste/domain/map-planning/areas,
//   the helper the map itself calls — the convex hull pushed 80 m out, or a
//   box 120 m past one or two spots) over the same containers — every one
//   the fixtures file under the area and the map places (in storage, in
//   transit and ended ones it does not), at the point the map places it,
//   which is where registry.ts stores its property (REGISTRY_MAP_PLACES).
//   The one exception is BIN-66420, which the map places at Nørrebrogade 144,
//   a street it knows and no fixture property: its spot counts, and nothing
//   stands there in the database. The vertices keep six decimals, the
//   decimetre the Registry's points keep, and the ring is closed on its first
//   vertex. Cairo's area has no located container, so it has no boundary.
//   Every boundary is in force from 2026-01-01, the day the seed's agreements
//   and price lists start, and open-ended: one version per area, since the
//   fixture's "Effective 1 Sep 2026" on Østerbro Zone 2 dates a revision the
//   prototype never drew. The areas overlap — each Copenhagen area's
//   containers are spread over the whole city by the generator's rotation —
//   and overlap is allowed (the schema's exclusion is per area, in time), so
//   a rule matches every container inside the boundary, including ones the
//   prototype filed under a neighbouring area: the consequence of replacing
//   an index with stored geography, not content anybody wrote.
//
//   Calendars. The five per-year records at their fixture names, each
//   period's inclusive last day made the first day out of force (+1 day, the
//   rule every fixture end date follows here: 31 Dec 2026 is 2027-01-01).
//   The holidays are the fixtures' dates, 11 + 11 + 0 + 1 + 8, named as the
//   calendar's project's holiday list names them — the lookup the prototype
//   and the generation job both read unnamed dates through
//   (`holidayNamesFor`, @waste/domain/route-schemes/holiday-names) — and
//   unnamed where the list does not name the date: Cairo's two Eid days of
//   2027. Harbor's calendar has no holidays and its "Draft" label no column:
//   Harbor Commercial names no holiday list, so the calendar is read by
//   nothing, which is the fixture's truth.
//
//   Schemes. The fixtures hold two Route Schemes, not the "38" their list's
//   tile shows, and both are Copenhagen Central's. Each is `validated`: the
//   prototype's Scheduled (RS-Central) is a reading of generated routes,
//   which the seed does not write, and validated is the stored half of the
//   lifecycle a person decides. Each starts on its fixture's first day and
//   is open-ended — RS-Østerbro's fixture end, 31 Dec 2026, is lifted, the
//   one date rule for a scheme here — and recurs as its typed values say
//   (weekly Mon–Fri from 06:00; every second, even ISO week on Tue and Thu
//   from 06:30). Neither fixture names a service type, which the prototype
//   reads as no restriction and the column requires: both are
//   `container-collection`, the vocabulary's general case; on the server a
//   service type restricts nothing, so RS-Østerbro's picks — a 140 L bin
//   and an igloo among them — stand as its fixture picks them. Nor does
//   either name a holiday policy or an edit policy, which the prototype
//   reads as `skip` and `ask`, the columns' defaults. Plan-ahead is on, the
//   column's default where the prototype reads the missing toggle as off:
//   the nightly sweep is how the Pilot's first routes are generated until an
//   office's Generate lands (#143, #97). RS-Central names its fixture's
//   "Nordhavn depot"; neither names an unloading station — the driver names
//   ARC Amager on the unload — and RS-Østerbro names no planning area, as
//   its fixture does not: its stops are picked.
//
//   Groups. Each scheme's implicit `default` group of the prototype
//   (`collectionGroupsOf`, @waste/domain/route-schemes/groups) is made an
//   explicit row, since the server keeps every group as one: named as its
//   scheme, first, running every service day. RS-Central's matches by rule —
//   Residual, on the rear-loader vehicle type, whose compatible container
//   types resources.ts writes — with WH-24 and Mads Jensen, its fixture's;
//   it names no provider, its hauler being Kystbyen itself. RS-Østerbro's
//   picks BIN-91007, BIN-91008, BIN-91010 and BIN-91011 in that order, runs
//   with NordRen's NR-08 under NordRen, and names no driver: its fixture's,
//   Lars Møller, holds a licence that ran out on 2026-09-05, and a group the
//   API would refuse to name him on is not seeded — the operator renews his
//   licence and assigns him, or another driver, before a dispatch. BIN-91007
//   stays picked: its fraction is Metal, which no product collects, so it has
//   no placement, and a generation run writes no pickup for it while the
//   other three generate — the expected result. The run's warning for it is
//   its `unlocated` count, the server's word for a pick it could not place;
//   the run's `warnings` hold the day-level sentences and stay empty. Neither
//   rule is restricted to container types.
//
//   Left out, having no column: a scheme's Version, Hauler and "Container
//   selection" facts and its counts ("214 stops/week"), a calendar's Week
//   start and Timezone (the project's), an area's Boundary status, size and
//   counts, and the prototype's `lastGeneratedAt` stamp on RS-Central, which
//   on the server is a generation run's own record.
import type { Polygon, Position } from "@waste/contracts/geojson"
import { planningAreaOutline } from "@waste/domain/map-planning/areas"
import type { LngLat } from "@waste/domain/map-planning/geo"
import type { PlanningAreaPurpose, RecurrenceFrequency, ServiceDay, StopSource, WeekRotation } from "@waste/domain/planning/vocabulary"
import { IMPLICIT_GROUP_ID } from "@waste/domain/route-schemes/groups"
import { holidayNamesFor } from "@waste/domain/route-schemes/holiday-names"
import { addDays } from "@waste/domain/route-schemes/recurrence"

import type { Tx } from "../client"
import { collectionCalendar, collectionCalendarHoliday } from "../schema/collection-calendars"
import { planningArea, planningAreaBoundary } from "../schema/planning-areas"
import { collectionGroup, collectionGroupContainer, collectionGroupContainerType, collectionGroupFraction, routeScheme } from "../schema/route-schemes"
import { DEMO_COMPANY_ID, DEMO_PROJECT_IDS, DEMO_SERVICE_PROVIDER_IDS, keyed, required } from "./ids"
import { REGISTRY_IDS, REGISTRY_MAP_PLACES, type MapPlaced } from "./registry"
import { RESOURCES_IDS } from "./resources"
import { replaceSets, upsertOwned } from "./upsert"

const COMPANY_ID = DEMO_COMPANY_ID

type PlanningProject = keyof typeof DEMO_PROJECT_IDS

/* ---------------------------------- areas ---------------------------------- */

type AreaSpec = { key: string; project: PlanningProject; code: string; name: string; purpose: PlanningAreaPurpose }
const AREAS: readonly AreaSpec[] = [
  { key: "area-indreby", project: "copenhagen", code: "OP-CEN-01", name: "Indre By Operations", purpose: "route-planning" },
  { key: "area-osterbro-contract", project: "copenhagen", code: "OP-Ø-02", name: "Østerbro Zone 2", purpose: "route-planning" },
  { key: "area-amager-1", project: "copenhagen", code: "OP-AM-01", name: "Amager Zone 1", purpose: "route-planning" },
  { key: "area-harbor-1", project: "harbor", code: "OP-HAR-01", name: "Nordhavn Harbor Area", purpose: "route-planning" },
  { key: "area-cairo-nasr", project: "cairo", code: "OP-CAI-01", name: "Nasr City Operations", purpose: "route-planning" },
]

/** The day every boundary is in force from. */
const BOUNDARIES_FROM = "2026-01-01"

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6

/** An outline as the column stores it: six decimals, the ring closed on its first vertex. */
function polygonOf(outline: readonly LngLat[]): Polygon {
  const ring: Position[] = outline.map((vertex) => [round6(vertex.lng), round6(vertex.lat)])
  return { type: "Polygon", coordinates: [[...ring, ring[0]]] }
}

/** The map's containers by the area their record files them under; an area the map places nothing in is absent. */
function boundarySources(): Record<string, MapPlaced[]> {
  const sources: Record<string, MapPlaced[]> = {}
  for (const placed of REGISTRY_MAP_PLACES) {
    if (!AREAS.some((area) => area.key === placed.area)) throw new Error(`planning seed: ${placed.container} is filed under ${placed.area}, which is no planning area`)
    const filed = (sources[placed.area] ??= [])
    filed.push(placed)
  }
  return sources
}

/** The containers each area's boundary is drawn around, by area. */
export const PLANNING_BOUNDARY_SOURCES: Readonly<Record<string, readonly MapPlaced[]>> = boundarySources()

/* -------------------------------- calendars -------------------------------- */

type CalendarSpec = {
  key: string
  project: PlanningProject
  name: string
  validFrom: string
  /** The fixture's last day, inclusive. */
  validThrough: string
  /** The project's holiday list, whose lookup names the dates (demo.ts spells it on the project); null for none. */
  holidayList: string | null
  holidays: readonly string[]
}
const CALENDARS: readonly CalendarSpec[] = [
  {
    key: "calendar-central",
    project: "copenhagen",
    name: "Copenhagen Central 2026",
    validFrom: "2026-01-01",
    validThrough: "2026-12-31",
    holidayList: "Danish public holidays",
    holidays: ["2026-01-01", "2026-04-02", "2026-04-03", "2026-04-05", "2026-04-06", "2026-05-14", "2026-05-24", "2026-05-25", "2026-06-05", "2026-12-25", "2026-12-26"],
  },
  {
    key: "calendar-central-2027",
    project: "copenhagen",
    name: "Copenhagen Central 2027",
    validFrom: "2027-01-01",
    validThrough: "2027-12-31",
    holidayList: "Danish public holidays",
    holidays: ["2027-01-01", "2027-03-25", "2027-03-26", "2027-03-28", "2027-03-29", "2027-05-06", "2027-05-16", "2027-05-17", "2027-06-05", "2027-12-25", "2027-12-26"],
  },
  { key: "calendar-harbor", project: "harbor", name: "Harbor Offices service calendar", validFrom: "2026-09-01", validThrough: "2027-08-31", holidayList: null, holidays: [] },
  { key: "calendar-cairo-2026", project: "cairo", name: "Cairo Operations 2026", validFrom: "2026-09-01", validThrough: "2026-12-31", holidayList: "Egyptian public holidays", holidays: ["2026-10-06"] },
  {
    key: "calendar-cairo-2027",
    project: "cairo",
    name: "Cairo Operations 2027",
    validFrom: "2027-01-01",
    validThrough: "2027-12-31",
    holidayList: "Egyptian public holidays",
    holidays: ["2027-01-07", "2027-01-25", "2027-03-08", "2027-03-09", "2027-04-25", "2027-05-01", "2027-06-30", "2027-07-23"],
  },
]

/* ----------------------------- schemes and groups ----------------------------- */

/** The prototype's implicit group of a scheme, as a row: its stop source, its rule or its picks, and its planned assignment. */
type GroupSpec = {
  stopSource: StopSource
  /** A vehicle type's key, for a rule. */
  ruleVehicleType: string | null
  /** Waste fraction keys, for a rule. */
  fractions: readonly string[]
  /** Container keys in stop order, for picks. */
  containers: readonly string[]
  provider: keyof typeof DEMO_SERVICE_PROVIDER_IDS | null
  vehicle: string | null
  driver: string | null
}
type SchemeSpec = {
  key: string
  project: PlanningProject
  name: string
  area: string | null
  frequency: RecurrenceFrequency
  serviceDays: readonly ServiceDay[]
  weekRotation: WeekRotation | null
  plannedStartTime: string
  validFrom: string
  depot: string | null
  group: GroupSpec
}
const SCHEMES: readonly SchemeSpec[] = [
  {
    key: "scheme-central-a",
    project: "copenhagen",
    name: "RS-Central · Week A",
    area: "area-indreby",
    frequency: "weekly",
    serviceDays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
    weekRotation: null,
    plannedStartTime: "06:00",
    validFrom: "2026-06-01",
    depot: "depot-nordhavn",
    group: { stopSource: "rule", ruleVehicleType: "rear-loader", fractions: ["residual"], containers: [], provider: null, vehicle: "vehicle-wh24", driver: "driver-mads" },
  },
  {
    key: "scheme-osterbro-b",
    project: "copenhagen",
    name: "RS-Østerbro · Organic B",
    area: null,
    frequency: "every-2-weeks",
    serviceDays: ["tuesday", "thursday"],
    weekRotation: "even",
    plannedStartTime: "06:30",
    validFrom: "2026-08-04",
    depot: null,
    group: {
      stopSource: "manual",
      ruleVehicleType: null,
      fractions: [],
      containers: ["asset-seed-91007", "asset-seed-91008", "asset-seed-91010", "asset-seed-91011"],
      provider: "nordren",
      vehicle: "vehicle-nr08",
      // Lars Møller in the fixture, whose licence ran out on 2026-09-05.
      driver: null,
    },
  },
]

/** A scheme's implicit group, keyed as the prototype keys it: `scheme-central-a:default`. */
const groupKeyOf = (scheme: SchemeSpec): string => `${scheme.key}:${IMPLICIT_GROUP_ID}`

/* --------------------------------- rows ----------------------------------- */

/** Every Planning id, keyed by the prototype's record id. */
export type PlanningIds = {
  planningAreas: Readonly<Record<string, string>>
  /** By the area it bounds: one version each. */
  planningAreaBoundaries: Readonly<Record<string, string>>
  collectionCalendars: Readonly<Record<string, string>>
  /** `<calendar>:<day>` */
  collectionCalendarHolidays: Readonly<Record<string, string>>
  routeSchemes: Readonly<Record<string, string>>
  /** `<scheme>:default`, the prototype's implicit group. */
  collectionGroups: Readonly<Record<string, string>>
  /** `<group>:<waste fraction key>` */
  collectionGroupFractions: Readonly<Record<string, string>>
  /** `<group>:<container>` */
  collectionGroupContainers: Readonly<Record<string, string>>
}

type PlanningRows = {
  planningAreas: (typeof planningArea.$inferInsert)[]
  planningAreaBoundaries: (typeof planningAreaBoundary.$inferInsert)[]
  collectionCalendars: (typeof collectionCalendar.$inferInsert)[]
  collectionCalendarHolidays: (typeof collectionCalendarHoliday.$inferInsert)[]
  routeSchemes: (typeof routeScheme.$inferInsert)[]
  collectionGroups: (typeof collectionGroup.$inferInsert)[]
  collectionGroupFractions: (typeof collectionGroupFraction.$inferInsert)[]
  collectionGroupContainers: (typeof collectionGroupContainer.$inferInsert)[]
}

/** How many rows the Planning seed holds per table. */
export type PlanningCounts = { [K in keyof PlanningRows]: number }

function build(): { ids: PlanningIds; rows: PlanningRows } {
  const areaIds = keyed(AREAS, (spec) => spec.key, "planningArea")
  const bounded = AREAS.filter((spec) => PLANNING_BOUNDARY_SOURCES[spec.key] !== undefined)
  const boundaryIds = keyed(bounded, (spec) => spec.key, "planningAreaBoundary")
  const areaId = (key: string) => required(areaIds, key, "planning area")
  const calendarIds = keyed(CALENDARS, (spec) => spec.key, "collectionCalendar")
  const holidays = CALENDARS.flatMap((spec) => spec.holidays.map((day) => ({ calendar: spec, day })))
  const holidayKey = (entry: (typeof holidays)[number]): string => `${entry.calendar.key}:${entry.day}`
  const holidayIds = keyed(holidays, holidayKey, "collectionCalendarHoliday")
  const schemeIds = keyed(SCHEMES, (spec) => spec.key, "routeScheme")
  const groupIds = keyed(SCHEMES, groupKeyOf, "collectionGroup")
  const ruleFractions = SCHEMES.flatMap((spec) => spec.group.fractions.map((fraction) => ({ group: groupKeyOf(spec), project: spec.project, fraction })))
  const ruleFractionKey = (entry: (typeof ruleFractions)[number]): string => `${entry.group}:${entry.fraction}`
  const ruleFractionIds = keyed(ruleFractions, ruleFractionKey, "collectionGroupFraction")
  const picks = SCHEMES.flatMap((spec) => spec.group.containers.map((container, index) => ({ group: groupKeyOf(spec), project: spec.project, container, position: index + 1 })))
  const pickKey = (entry: (typeof picks)[number]): string => `${entry.group}:${entry.container}`
  const pickIds = keyed(picks, pickKey, "collectionGroupContainer")
  const groupId = (key: string) => required(groupIds, key, "collection group")
  /** The id keyed `key`, or null where the spec names none. */
  const optional = (ids: Readonly<Record<string, string>>, key: string | null, what: string) => (key === null ? null : required(ids, key, what))

  return {
    ids: {
      planningAreas: areaIds,
      planningAreaBoundaries: boundaryIds,
      collectionCalendars: calendarIds,
      collectionCalendarHolidays: holidayIds,
      routeSchemes: schemeIds,
      collectionGroups: groupIds,
      collectionGroupFractions: ruleFractionIds,
      collectionGroupContainers: pickIds,
    },
    rows: {
      planningAreas: AREAS.map((spec) => ({
        id: areaId(spec.key),
        companyId: COMPANY_ID,
        projectId: DEMO_PROJECT_IDS[spec.project],
        code: spec.code,
        name: spec.name,
        purpose: spec.purpose,
      })),
      planningAreaBoundaries: bounded.map((spec) => ({
        id: required(boundaryIds, spec.key, "boundary"),
        companyId: COMPANY_ID,
        projectId: DEMO_PROJECT_IDS[spec.project],
        validFrom: BOUNDARIES_FROM,
        validTo: null,
        planningAreaId: areaId(spec.key),
        boundary: polygonOf(planningAreaOutline(PLANNING_BOUNDARY_SOURCES[spec.key].map(({ spot }) => ({ lng: spot.coordinates[0], lat: spot.coordinates[1] })))),
      })),
      collectionCalendars: CALENDARS.map((spec) => ({
        id: required(calendarIds, spec.key, "calendar"),
        companyId: COMPANY_ID,
        projectId: DEMO_PROJECT_IDS[spec.project],
        validFrom: spec.validFrom,
        validTo: addDays(spec.validThrough, 1),
        name: spec.name,
      })),
      collectionCalendarHolidays: holidays.map((entry) => ({
        id: required(holidayIds, holidayKey(entry), "holiday"),
        companyId: COMPANY_ID,
        projectId: DEMO_PROJECT_IDS[entry.calendar.project],
        collectionCalendarId: required(calendarIds, entry.calendar.key, "calendar"),
        day: entry.day,
        name: holidayNamesFor(entry.calendar.holidayList ?? undefined)(entry.day) ?? null,
      })),
      routeSchemes: SCHEMES.map((spec) => ({
        id: required(schemeIds, spec.key, "route scheme"),
        companyId: COMPANY_ID,
        projectId: DEMO_PROJECT_IDS[spec.project],
        validFrom: spec.validFrom,
        validTo: null,
        name: spec.name,
        planningAreaId: spec.area === null ? null : areaId(spec.area),
        serviceType: "container-collection",
        frequency: spec.frequency,
        serviceDays: [...spec.serviceDays],
        weekRotation: spec.weekRotation,
        plannedStartTime: spec.plannedStartTime,
        holidayPolicy: "skip",
        editPolicy: "ask",
        planAhead: true,
        status: "validated",
        depotId: optional(RESOURCES_IDS.depots, spec.depot, "depot"),
        unloadingStationId: null,
      })),
      collectionGroups: SCHEMES.map((spec) => ({
        id: groupId(groupKeyOf(spec)),
        companyId: COMPANY_ID,
        projectId: DEMO_PROJECT_IDS[spec.project],
        routeSchemeId: required(schemeIds, spec.key, "route scheme"),
        name: spec.name,
        position: 1,
        days: [...spec.serviceDays],
        stopSource: spec.group.stopSource,
        ruleVehicleTypeId: optional(RESOURCES_IDS.vehicleTypes, spec.group.ruleVehicleType, "vehicle type"),
        serviceProviderId: spec.group.provider === null ? null : DEMO_SERVICE_PROVIDER_IDS[spec.group.provider],
        vehicleId: optional(RESOURCES_IDS.vehicles, spec.group.vehicle, "vehicle"),
        driverId: optional(RESOURCES_IDS.drivers, spec.group.driver, "driver"),
      })),
      collectionGroupFractions: ruleFractions.map((entry) => ({
        id: required(ruleFractionIds, ruleFractionKey(entry), "rule fraction"),
        companyId: COMPANY_ID,
        projectId: DEMO_PROJECT_IDS[entry.project],
        collectionGroupId: groupId(entry.group),
        wasteFractionId: required(REGISTRY_IDS.wasteFractions, entry.fraction, "waste fraction"),
      })),
      collectionGroupContainers: picks.map((entry) => ({
        id: required(pickIds, pickKey(entry), "picked container"),
        companyId: COMPANY_ID,
        projectId: DEMO_PROJECT_IDS[entry.project],
        collectionGroupId: groupId(entry.group),
        containerId: required(REGISTRY_IDS.containers, entry.container, "container"),
        position: entry.position,
      })),
    },
  }
}

const built = build()

/** Every Planning id the seed writes. */
export const PLANNING_IDS: PlanningIds = built.ids

const PLANNING_ROWS: Readonly<PlanningRows> = built.rows

export const PLANNING_COUNTS: PlanningCounts = Object.fromEntries(Object.entries(built.rows).map(([table, rows]) => [table, rows.length])) as PlanningCounts

/** Writes Planning into an open transaction, after the Registry and Resources whose rows it names, and answers how many rows it changed. */
export async function applyPlanning(tx: Tx): Promise<number> {
  const rows = PLANNING_ROWS
  let changed = 0
  // An area's `code` is set once (planning-areas.ts): spelled on insert, never rewritten.
  changed += await upsertOwned(tx, planningArea, rows.planningAreas, [planningArea.name, planningArea.purpose])
  changed += await upsertOwned(tx, planningAreaBoundary, rows.planningAreaBoundaries, [
    planningAreaBoundary.validFrom,
    planningAreaBoundary.validTo,
    planningAreaBoundary.planningAreaId,
    planningAreaBoundary.boundary,
  ])
  changed += await upsertOwned(tx, collectionCalendar, rows.collectionCalendars, [collectionCalendar.validFrom, collectionCalendar.validTo, collectionCalendar.name])
  // A calendar's holidays, a set `PUT …/holidays` replaces whole.
  changed += await replaceSets(tx, {
    table: collectionCalendarHoliday,
    of: collectionCalendarHoliday.collectionCalendarId,
    parents: Object.values(PLANNING_IDS.collectionCalendars),
    rows: rows.collectionCalendarHolidays,
    compared: [collectionCalendarHoliday.day, collectionCalendarHoliday.name],
  })
  changed += await upsertOwned(tx, routeScheme, rows.routeSchemes, [
    routeScheme.validFrom,
    routeScheme.validTo,
    routeScheme.name,
    routeScheme.planningAreaId,
    routeScheme.serviceType,
    routeScheme.frequency,
    routeScheme.serviceDays,
    routeScheme.weekRotation,
    routeScheme.plannedStartTime,
    routeScheme.holidayPolicy,
    routeScheme.editPolicy,
    routeScheme.planAhead,
    routeScheme.status,
    routeScheme.depotId,
    routeScheme.unloadingStationId,
  ])
  changed += await upsertOwned(tx, collectionGroup, rows.collectionGroups, [
    collectionGroup.routeSchemeId,
    collectionGroup.name,
    collectionGroup.position,
    collectionGroup.days,
    collectionGroup.stopSource,
    collectionGroup.ruleVehicleTypeId,
    collectionGroup.serviceProviderId,
    collectionGroup.vehicleId,
    collectionGroup.driverId,
  ])
  // A group's rule and its picks are sets the API replaces whole; the seed owns every one of its groups' three, the empty ones included.
  const groups = Object.values(PLANNING_IDS.collectionGroups)
  changed += await replaceSets(tx, {
    table: collectionGroupFraction,
    of: collectionGroupFraction.collectionGroupId,
    parents: groups,
    rows: rows.collectionGroupFractions,
    compared: [collectionGroupFraction.wasteFractionId],
  })
  changed += await replaceSets(tx, {
    table: collectionGroupContainerType,
    of: collectionGroupContainerType.collectionGroupId,
    parents: groups,
    rows: [],
    compared: [collectionGroupContainerType.containerTypeId],
  })
  changed += await replaceSets(tx, {
    table: collectionGroupContainer,
    of: collectionGroupContainer.collectionGroupId,
    parents: groups,
    rows: rows.collectionGroupContainers,
    compared: [collectionGroupContainer.containerId, collectionGroupContainer.position],
  })
  return changed
}
