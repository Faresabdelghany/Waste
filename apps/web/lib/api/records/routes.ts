// Routes on the prototype's records (Issue #179, slice 6 of #81): the dated
// Route generation wrote, as the rows of `route-studio.routes` — the table,
// the map's Routes layer and the route's details read them. The wire shapes
// are the contracts' (`@waste/contracts/routes`), imported as types so no zod
// reaches the bundle; the routes are apps/api/src/routes/routes.ts.
//
// A route is written by generation (the office asks for a run on its scheme,
// the nightly sweep runs on its own), or made by the office as an ad-hoc
// route with no scheme (#111: `POST /routes`, the module's New route, its
// Origin fact saying so), and never edited: the dispatcher moves it by its
// commands — `assign` the Planned Assignment,
// `dispatch` it to its driver, `reschedule` the day it runs or its planned
// start (never its service date, the identity), `cancel` it with a reason,
// which becomes its note, put its open stops in order (`PUT
// /routes/:id/pickup-order`, a manual Plan), and add a stop of the office's
// own (`POST /routes/:id/pickups`, #111), which answers the stop and so has
// the route read back after it. So the adapter lists no
// `statuses` and refuses every patch: the status and every field move by
// command alone. What a route may take is the API's to say — every command
// is offered and its 409 speaks (the rules on #81): a dispatch without a
// planned driver, an assign on a route that has started. A route without a
// Plan is complete, and nothing routing does gates a dispatch (#132).
//
// Relations by web id through the store's resolver: the project and the
// service provider (the organisation), the vehicle, the trailer and the
// driver (5a's fleet), the depot and the unloading station (5a's places), by
// their names once loaded and as id chips until then; the scheme as
// `scheme-<uuid>` — the web id #177's adapter gives it, so the link lands
// once the schemes load — and its collection group as `group-<uuid>`. No
// fixture lends its id: RC-1042 is a fixture's name too, and a server route
// is `route-<uuid>` from the start (the plan on #81, fixture ids (b)).
//
// The list carries no pickups; the route's own read (`routeDetail`) gives
// them in their sequence — the active Plan's order where there is one — with
// its sessions and unloads, and the read's `activePlan` goes on the record
// as JSON under `ROUTE_ACTIVE_PLAN_KEY`, which the map's legs layer reads
// (#173): absent where the read carries none (the list, until #173 adds it).
//
// Since O5 of #290 the office's dispatch-day tooling: a day's routes, or a
// selection, dispatched in one request (`dispatchRoutes`, each route answered
// on its own), Optimise from the route's details (`OPTIMISE_ROUTE`, which
// answers the Plan and so has the route read back), the active Plan's
// distance and duration as the route's facts, the route's Plans as its
// history (`routePlans`), the service provider on Assign, a reschedule onto a
// non-working day only when the dialog says so, and the cancel's reason code.
//
// Since O23 of #290 a route's open stops move onto another route of its
// project (`MOVE_STOPS`), split off onto a new route of its day
// (`SPLIT_ROUTE`, which answers the new route and so has this one read back),
// or come over from a route merged into it (`MERGE_ROUTE`); each reads the
// routes again, since another route than the one it is sent on changed.
import type { DriverCommandReceipt } from "@waste/contracts/driver-commands"
import type { PickupDetail } from "@waste/contracts/pickups"
import type { OptimiseAnswer, Plan } from "@waste/contracts/plans"
import type { Route, RouteDetail, RouteDispatchResults, RouteShift, RouteWorkload } from "@waste/contracts/routes"
import { OFFICE_CANCEL_REASON_CODES, OFFICE_STOP_SERVICES, type OfficeStopService } from "@waste/domain/execution/vocabulary"
import { BOOKED_WITH, type BookedField } from "@waste/domain/execution/work-orders"
import type { PlanStopWarning } from "@waste/domain/routing/vocabulary"

import { FIXTURE_COMPANY_ID, type BusinessRecord, type ModuleLocation } from "@/lib/data/business-modules"
import { isSubscriptionRecord, PROPERTY_PREFIX, SHARED_POINT_PREFIX, SUBSCRIPTION_PREFIX } from "@/lib/data/agreements"
import { masterDataKindOf } from "@/lib/data/master-data"
import { A_WORK_ORDER_IS_OF_A_CONTAINER } from "@/lib/data/pickup-services"
import { isPropertyRecord, isSharedPointRecord } from "@/lib/data/properties"
import { formatDistance, formatDuration } from "@/lib/map-planning/format"
import { ROUTE_ACTIVE_PLAN_KEY, STOP_AT_BULKY_BOOKING, STOP_AT_CONTAINER, STOP_AT_POINT, STOP_AT_PROPERTY } from "@/lib/data/routes"

import { command, create, get, listAll, put } from "../client"
import { hasPrefix, inheritedPresentation, isLocalRefusal, moduleKeyOf, ofKind, said, stampFacts, statusLabel, typed, webIdOf, type Client, type MappingContext, type RecordCommand, type ResourceAdapter, type ServerModule } from "./adapter"
import { FLEET_AND_DEPOT_PICKS } from "./allocations"
import { shownOn } from "./clock"
import { containerAdapter } from "./containers"
import { serviceProviderAdapter } from "./organisation"
import { projectServerIdOf, referenced, refusal, unloadingStationAdapter, warehouseAdapter } from "./places"
import { nameVia, referencedServerId, webIdVia, type ReferenceRule } from "./references"
import { shiftFact } from "./time-windows"

/** The workspace module the routes are the rows of. */
export const ROUTES_MODULE: ModuleLocation = { workspaceId: "route-studio", moduleId: "routes" }

/**
 * How far back the routes and their stops are read: a window from this many
 * days ago with no end, the recent routes and every future one. Named here
 * once; the stops read by it too (pickups.ts). The bound is the UTC day's, a
 * day's slack either side being nothing against 35.
 */
export const ROUTES_WINDOW_DAYS = 35

/** The first operating day the routes are read from, `from` on their lists. */
export function routesWindowFrom(now = new Date()): string {
  const from = new Date(now.getTime())
  from.setUTCDate(from.getUTCDate() - ROUTES_WINDOW_DAYS)
  return from.toISOString().slice(0, 10)
}

// The modules a route's command changes the rows of too, spelled here: their own constants sit in files built on this one (live.ts, pickups.ts).
const LIVE_KEY = moduleKeyOf(ROUTES_MODULE.workspaceId, "live")
/** The routes themselves: a move, a split or a merge changes another route than the one it is sent on, or makes one. */
const ROUTES_KEY = moduleKeyOf(ROUTES_MODULE.workspaceId, ROUTES_MODULE.moduleId)
const PICKUPS_KEY = moduleKeyOf(ROUTES_MODULE.workspaceId, "pickups")
/** The bulky bookings (O11 of #290): a stop added for one routes it, and a stop of one skipped books it again. */
const BULKY_KEY = moduleKeyOf("operate", "bulky-bookings")

/** The route's commands, by the names the surfaces send. */
export const ASSIGN_ROUTE = "assign"
export const DISPATCH_ROUTE = "dispatch"
export const RESCHEDULE_ROUTE = "reschedule"
export const CANCEL_ROUTE = "cancel"
export const REORDER_ROUTE = "reorder"
/** The office's hand-back of a held route to its scheme (#226). */
export const RELEASE_HOLD = "release-hold"
/** A stop the office adds to a route that has not started (#111). */
export const ADD_STOP = "add-stop"
/** The office's ask for a Plan over the route's open stops (O5 of #290): the optimiser's order, or a measured baseline where it cannot take the route. */
export const OPTIMISE_ROUTE = "optimise"
/** Open stops moved onto another route of the project (O23 of #290). */
export const MOVE_STOPS = "move-stops"
/** Open stops split off onto a new ad-hoc route of the day (O23 of #290). */
export const SPLIT_ROUTE = "split"
/** Another route's open stops merged onto this one, that route cancelled as merged (O23 of #290). */
export const MERGE_ROUTE = "merge"

/** What an ad-hoc route says it is, under its Origin fact (#111): the office's own, with no scheme. */
export const MADE_BY_THE_OFFICE = "Made by the office"

const ROUTE_PREFIX = "route"
const SCHEME_PREFIX = "scheme"
const GROUP_PREFIX = "group"
const PICKUP_PREFIX = "pickup"

/** A route as a read may carry it: the list's and the detail's with the active Plan and the workload (O10 of #290), the live read's with the Plan alone. */
type RouteRead = Route & { activePlan?: RouteDetail["activePlan"]; workload?: RouteWorkload; shift?: RouteShift }

/** "WH-24" for "WH-24 · CN 42 018": a vehicle as the fixtures and the map name it, its callsign; an id chip as it stands. */
export const callsignOf = (name: string) => name.split(" · ")[0] ?? name

/** "Mads Jensen · WH-31 · TR-12": a driver, a vehicle and a trailer as an assignment — planned, actual, a session's — reads; undefined when it names none. */
export function assignmentOf(context: MappingContext, { driverId, vehicleId, trailerId }: { driverId: string | null; vehicleId: string | null; trailerId: string | null }): string | undefined {
  const parts = [driverId === null ? undefined : nameVia(context, "driver", driverId), ...[vehicleId, trailerId].map((id) => (id === null ? undefined : callsignOf(nameVia(context, "vehicle", id))))].filter(Boolean)
  return parts.length === 0 ? undefined : parts.join(" · ")
}

/** "3 stops", "1 stop", "2/3 stops" once any stop is decided: the map counts a route's stops off the first. */
function stopsValue({ planned, total }: Route["progress"]): string {
  if (planned === total) return `${total} ${total === 1 ? "stop" : "stops"}`
  return `${total - planned}/${total} stops`
}

/** The project a route is in: its web id, its name, its clock. */
function projectOf(route: Route, context: MappingContext): { webId: string; name?: string; timezone?: string } {
  const record = context.resolve.byServerId(route.projectId)
  const { webId, name } = referenced(context, "project", route.projectId)
  return { webId, name, timezone: record === undefined ? undefined : typed(record, "timezone") }
}

/** What ends a route's hold (#209, the API's `route-holds.ts`). */
const HOLD_RELEASED_BY = "Release hold; an edit of its scheme's start, depot or unloading station, or of its group's vehicle, driver or provider; a day taken from its collection; a dispatch or a cancel"

/** Whether the office holds the route (#209): `release-hold` hands it back (#226). */
export const isHeldRoute = (record: Pick<BusinessRecord, "submittedValues">): boolean => typeof record.submittedValues?.heldAt === "string" && record.submittedValues.heldAt !== ""

export function toRouteRecord(route: RouteRead, context: MappingContext): BusinessRecord {
  const project = projectOf(route, context)
  const at = (instant: string | null) => (instant === null ? undefined : shownOn(instant, project.timezone))
  const vehicle = route.planned.vehicleId === null ? undefined : callsignOf(nameVia(context, "vehicle", route.planned.vehicleId))
  const driver = route.planned.driverId === null ? undefined : nameVia(context, "driver", route.planned.driverId)
  const trailer = route.planned.trailerId === null ? undefined : callsignOf(nameVia(context, "vehicle", route.planned.trailerId))
  // The office's ad-hoc route (#111) names no scheme and no group.
  const scheme = route.routeSchemeId === null ? undefined : context.resolve.byServerId(route.routeSchemeId)
  // The route carries no area on the wire: it is filed under its scheme's, once the schemes are loaded (#177).
  const area = scheme?.facts["Planning area"]
  const facts: Record<string, string> = {
    Project: project.name ?? project.webId,
    ...(area === undefined ? {} : { Area: area }),
    // An ad-hoc route says whose it is where a generated one names its scheme.
    ...(route.routeSchemeId === null ? { Origin: MADE_BY_THE_OFFICE } : { "Route scheme": nameVia(context, SCHEME_PREFIX, route.routeSchemeId) }),
    "Service date": route.serviceDate,
    "Operating date": route.operatingDate,
  }
  if (route.plannedStartTime !== null) facts["Planned start"] = route.plannedStartTime
  if (vehicle !== undefined) facts.Vehicle = vehicle
  if (driver !== undefined) facts.Driver = driver
  if (trailer !== undefined) facts.Trailer = trailer
  if (route.planned.serviceProviderId !== null) facts["Service provider"] = nameVia(context, "service-provider", route.planned.serviceProviderId)
  if (route.planned.depotId !== null) facts.Depot = nameVia(context, "depot", route.planned.depotId)
  if (route.planned.unloadingStationId !== null) facts.Unloading = nameVia(context, "station", route.planned.unloadingStationId)
  // The active Plan's measure, once it has one (O5 of #290): the road the route drives and how long it takes, the time at its stops added (O10).
  const plan = "activePlan" in route ? route.activePlan : undefined
  const workload = "workload" in route ? route.workload : undefined
  if (plan?.distanceMetres != null) facts.Distance = formatDistance(plan.distanceMetres)
  if (plan?.durationSeconds != null) facts.Duration = formatDuration(plan.durationSeconds + (workload?.stopSeconds ?? 0))
  if (workload !== undefined) Object.assign(facts, workloadFacts(workload, plan?.unloads.length ?? 0))
  const unloads = plan?.unloads ?? []
  if (unloads.length > 0) facts["Unloads on the way"] = unloadsFact(unloads.length)
  if ("shift" in route && route.shift !== undefined) Object.assign(facts, shiftFacts(route.shift))
  const warned = plan?.stopWarnings ?? []
  if (warned.length > 0) facts["Window warnings"] = warned.map((stop) => `Stop ${stop.position}: ${STOP_WARNING_SENTENCES[stop.warning]}`).join("; ")
  if (route.cancelReasonCode !== null) facts["Cancel reason"] = statusLabel(route.cancelReasonCode)
  // A generated route's note is how it deviated from its scheme; the office's own route has no scheme to deviate from, and its note is the one New route took (#111).
  facts[route.routeSchemeId === null ? "Note" : "Deviation"] = route.note ?? "None"
  // Every stop it has, decided or not, as a generated route's fact in fixture mode: the scheme's routes table reads it (#252).
  facts.Stops = String(route.progress.total)
  // A route the office moved by hand is held (#209): generation keeps what the office moved until an edit of the same releases it.
  const held = at(route.heldAt)
  if (held !== undefined) {
    facts.Hold = `Moved by the office ${held}: generation runs keep its day, its start and its Planned Assignment, and still refresh its stops`
    facts["Hold released by"] = HOLD_RELEASED_BY
  }
  const stamps: Array<[string, string | undefined]> = [
    ["Dispatched at", at(route.dispatchedAt)],
    ["Started at", at(route.startedAt)],
    ["Completed at", at(route.completedAt)],
    ["Cancelled at", at(route.cancelledAt)],
  ]
  for (const [fact, value] of stamps) if (value !== undefined) facts[fact] = value
  const actual = assignmentOf(context, route.actual)
  if (actual !== undefined) facts["Actual assignment"] = actual
  const reference = (prefix: string, serverId: string | null) => (serverId === null ? "" : webIdVia(context, prefix, serverId))
  return {
    id: webIdOf(ROUTE_PREFIX, route.id),
    name: route.label,
    context: [project.name ?? project.webId, area].filter(Boolean).join(" · "),
    status: statusLabel(route.status),
    ...inheritedPresentation(undefined),
    ...stampFacts(route, context.now),
    owner: driver ?? "Unassigned",
    value: stopsValue(route.progress),
    description: `${route.routeSchemeId === null ? "The office's own route, with no scheme," : `Generated from ${scheme?.name ?? "its route scheme"}`} for ${route.serviceDate}${route.operatingDate === route.serviceDate ? "" : `, running ${route.operatingDate}`}.${held === undefined ? "" : ` Held by the office since ${held}.`}`,
    facts,
    companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
    projectIds: [project.webId],
    ...(route.planned.serviceProviderId === null ? {} : { serviceProviderId: webIdVia(context, "service-provider", route.planned.serviceProviderId) }),
    recordKind: "Route",
    submittedValues: {
      projectId: project.webId,
      schemeId: reference(SCHEME_PREFIX, route.routeSchemeId),
      // A group is no record of its own (it rides in its scheme's JSON, #201): the resolver would miss it every time.
      collectionGroupId: route.collectionGroupId === null ? "" : webIdOf(GROUP_PREFIX, route.collectionGroupId),
      serviceDate: route.serviceDate,
      operatingDate: route.operatingDate,
      // The date the map, the stop index and the scheme's tabs read a generated route by.
      actualDate: route.operatingDate,
      plannedStartTime: route.plannedStartTime ?? "",
      vehicleId: reference("vehicle", route.planned.vehicleId),
      driverId: reference("driver", route.planned.driverId),
      trailerId: reference("vehicle", route.planned.trailerId),
      serviceProviderId: reference("service-provider", route.planned.serviceProviderId),
      depotId: reference("depot", route.planned.depotId),
      unloadingStationId: reference("station", route.planned.unloadingStationId),
      status: route.status,
      cancelReasonCode: route.cancelReasonCode ?? "",
      heldAt: route.heldAt ?? "",
      ...("activePlan" in route ? { [ROUTE_ACTIVE_PLAN_KEY]: JSON.stringify(route.activePlan ?? null) } : {}),
    },
  }
}

// ---------------------------------------------------------------------------
// The dispatcher's commands
// ---------------------------------------------------------------------------
//
// Each answers the route as it now stands (`RouteDetail`), which replaces the
// row. A dialog names rows by web id; the body names them by server id,
// through the resolver or the id chip a row of a module not loaded shows. An
// assign and a reschedule send only what moved: the API checks every field
// a body names again (a licence, a status), so an unchanged one is left out.
// A field the input does not name at all is left as the route stands when the
// command is sent, so a scheme's one-off names only what it moves (#209); the
// dialogs name every field, a cleared one as "".

/** What an assign may move — the field, the id chip's prefix, the sentence a miss is refused in, the kind a loaded row is held to: the fleet's and the depot's chips as the allocations name them (allocations.ts), the unloading station, and the service provider (O5 of #290). */
const ASSIGNED: ReadonlyArray<readonly [string, string, string, ReferenceRule]> = [
  ...(Object.entries(FLEET_AND_DEPOT_PICKS) as ReadonlyArray<[string, readonly [string, string, ReferenceRule]]>).map(([field, [prefix, sentence, rule]]) => [field, prefix, sentence, rule] as const),
  ["unloadingStationId", "station", "Pick an unloading station the API holds", { owns: unloadingStationAdapter.owns }],
  ["serviceProviderId", "service-provider", "Pick a service provider the API holds", { owns: (record) => serviceProviderAdapter.owns(record) }],
]

const NOTHING_TO_ASSIGN = "Nothing to assign: pick another vehicle, driver, trailer, service provider, depot or unloading station"
const NOTHING_TO_RESCHEDULE = "Nothing to reschedule: move the day it runs or its planned start"
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/

/** A command posted to its path on the route. The Live board reads the routes' rows, so every one touches it; a cancel closes the route's open stops too. */
const onRoute = (path: string, verb: string, toBody?: RecordCommand<Route>["toBody"], touches: readonly string[] = [LIVE_KEY]): RecordCommand<Route> => ({
  ...(toBody === undefined ? {} : { toBody }),
  run: (client, serverId, body) => command<RouteDetail>(client, `/routes/${serverId}/${path}`, body),
  refused: (record) => `${record.name} was not ${verb}`,
  touches,
})

/** What a move, a split or a merge changes beside the route it is sent on: the other route, or the new one, the stops on both, the Live board, and a bulky booking whose stop moved. */
const STOPS_MOVED = [ROUTES_KEY, PICKUPS_KEY, LIVE_KEY, BULKY_KEY]

export const ROUTE_COMMANDS = {
  [ASSIGN_ROUTE]: onRoute("assign", "assigned", (input, record, context) => {
    const body: Record<string, string | null> = {}
    for (const [field, prefix, sentence, rule] of ASSIGNED) {
      if (!(field in input)) continue
      const was = typed(record, field)
      const is = said(input, field)
      if (is === was) continue
      if (is === undefined) {
        body[field] = null
        continue
      }
      const serverId = referencedServerId(is, prefix, context, rule)
      if (serverId === undefined) return refusal(field, sentence)
      // The same row under another spelling — its id chip, its loaded id — is no move.
      if (was !== undefined && referencedServerId(was, prefix, context, rule) === serverId) continue
      body[field] = serverId
    }
    return Object.keys(body).length === 0 ? refusal("vehicleId", NOTHING_TO_ASSIGN) : body
  }),
  [DISPATCH_ROUTE]: onRoute("dispatch", "dispatched"),
  // The route back on its scheme: the API asks a generation run over its service date, which brings back the scheme's day, start and assignment.
  [RELEASE_HOLD]: onRoute("release-hold", "handed back", () => ({})),
  [RESCHEDULE_ROUTE]: onRoute("reschedule", "rescheduled", (input, record) => {
    const day = "operatingDate" in input ? said(input, "operatingDate") : typed(record, "operatingDate")
    const start = "plannedStartTime" in input ? said(input, "plannedStartTime") : typed(record, "plannedStartTime")
    if (day === undefined) return refusal("operatingDate", "A route runs on a day: give its operating date")
    if (!ISO_DAY.test(day)) return refusal("operatingDate", "Give the day it runs as a date")
    if (start !== undefined && !CLOCK_TIME.test(start)) return refusal("plannedStartTime", "Give the planned start as HH:MM")
    const body: { operatingDate?: string; plannedStartTime?: string | null; acceptNonWorkingDay?: true } = {}
    if (day !== typed(record, "operatingDate")) body.operatingDate = day
    if (start !== typed(record, "plannedStartTime")) body.plannedStartTime = start ?? null
    if (Object.keys(body).length === 0) return refusal("operatingDate", NOTHING_TO_RESCHEDULE)
    // A day the project rests on is taken only when the dialog says so (O5 of #290); said on a move of the day alone, since a start moved on the same day asks no calendar.
    return input.acceptNonWorkingDay === true && body.operatingDate !== undefined ? { ...body, acceptNonWorkingDay: true } : body
  }),
  [CANCEL_ROUTE]: onRoute(
    "cancel",
    "cancelled",
    (input) => {
      // One of the office's codes (O5 of #290), then the free reason, which becomes the route's note.
      const reasonCode = said(input, "reasonCode")
      if (reasonCode === undefined || !(OFFICE_CANCEL_REASON_CODES as readonly string[]).includes(reasonCode)) return refusal("reasonCode", "Pick why the route is cancelled")
      const reason = said(input, "reason")
      return reason === undefined ? refusal("reason", "Say why the route is cancelled") : { reasonCode, reason }
    },
    // A cancel skips the open stops, a bulky booking's among them, which books it again.
    [PICKUPS_KEY, LIVE_KEY, BULKY_KEY],
  ),
  // A stop of the office's own (#111): a container, or an address with the fraction collected there. The API answers the stop; the route is read back for the row, its stops and its progress.
  [ADD_STOP]: {
    toBody: (input, _record, context) => addedStopBody(input, context),
    run: async (client, serverId, body) => {
      await create<PickupDetail>(client, `/routes/${serverId}/pickups`, body)
      return routeDetail(client, serverId)
    },
    refused: (record) => `No stop was added to ${record.name}`,
    touches: [PICKUPS_KEY, LIVE_KEY, BULKY_KEY],
  },
  // A Plan over the route's open stops (O5 of #290): the API answers the Plan, calculating or re-activated, so the route is read back for its active Plan.
  [OPTIMISE_ROUTE]: {
    run: async (client, serverId) => {
      await command<OptimiseAnswer>(client, `/routes/${serverId}/optimise`)
      return routeDetail(client, serverId)
    },
    refused: (record) => `${record.name} was not optimised`,
    touches: [PICKUPS_KEY, LIVE_KEY],
  },
  // Every open stop once, in the order they will be visited: the API makes it a manual Plan.
  [REORDER_ROUTE]: {
    toBody: (input, _record, context) => {
      const ids = Array.isArray(input.pickupIds) ? input.pickupIds.filter((id): id is string => typeof id === "string") : []
      if (ids.length === 0) return refusal("pickupIds", "Order the route's open stops")
      const serverIds = ids.map((id) => referencedServerId(id, PICKUP_PREFIX, context, { owns: hasPrefix(PICKUP_PREFIX) }))
      if (serverIds.some((id) => id === undefined)) return refusal("pickupIds", "Order the stops the API holds for this route")
      return { pickupIds: serverIds }
    },
    run: (client, serverId, body) => put<RouteDetail>(client, `/routes/${serverId}/pickup-order`, body),
    refused: (record) => `The stops of ${record.name} were not reordered`,
    // The stops list each one's sequence (#219), which the new order moves.
    touches: [PICKUPS_KEY, LIVE_KEY],
  },
  // Open stops onto another route (O23 of #290): the API answers this route, the stops gone; the other route, the stops and the Live board are read again.
  [MOVE_STOPS]: {
    toBody: (input, _record, context) => {
      const stops = movedStops(input, context)
      if (!("pickupIds" in stops)) return stops
      const toRouteId = otherRouteOf(input, "toRouteId", context)
      return typeof toRouteId === "string" ? { ...stops, toRouteId } : toRouteId
    },
    run: (client, serverId, body) => command<RouteDetail>(client, `/routes/${serverId}/move-stops`, body),
    refused: (record) => `No stop of ${record.name} was moved`,
    touches: STOPS_MOVED,
  },
  // Open stops onto a new route of the day (O23 of #290): the API answers the new route, so this one is read back, and the routes with it.
  [SPLIT_ROUTE]: {
    toBody: (input, _record, context) => {
      const stops = movedStops(input, context)
      if (!("pickupIds" in stops)) return stops
      const note = said(input, "note")
      return note === undefined ? stops : { ...stops, note }
    },
    run: async (client, serverId, body) => {
      await create<RouteDetail>(client, `/routes/${serverId}/split`, body)
      return routeDetail(client, serverId)
    },
    refused: (record) => `${record.name} was not split`,
    touches: STOPS_MOVED,
  },
  // Another route's open stops onto this one, that route cancelled as merged (O23 of #290): the API answers this route.
  [MERGE_ROUTE]: {
    toBody: (input, _record, context) => {
      const routeId = otherRouteOf(input, "routeId", context)
      return typeof routeId === "string" ? { routeId } : routeId
    },
    run: (client, serverId, body) => command<RouteDetail>(client, `/routes/${serverId}/merge`, body),
    refused: (record) => `Nothing was merged into ${record.name}`,
    touches: STOPS_MOVED,
  },
} satisfies Record<string, RecordCommand<Route>>

/** The open stops a move or a split names, each by server id; a refusal where none is picked or one is not a stop the API holds. */
function movedStops(input: Record<string, unknown>, context: MappingContext): { pickupIds: string[] } | ReturnType<typeof refusal> {
  const ids = Array.isArray(input.pickupIds) ? input.pickupIds.filter((id): id is string => typeof id === "string") : []
  if (ids.length === 0) return refusal("pickupIds", "Pick the stops to move")
  const serverIds = ids.map((id) => referencedServerId(id, PICKUP_PREFIX, context, { owns: hasPrefix(PICKUP_PREFIX) }))
  if (serverIds.some((id) => id === undefined)) return refusal("pickupIds", "Pick stops the API holds for this route")
  return { pickupIds: serverIds as string[] }
}

/** The other route a move goes to or a merge takes in, by server id; a refusal where none is picked or it is not a route the API holds. */
function otherRouteOf(input: Record<string, unknown>, field: "toRouteId" | "routeId", context: MappingContext): string | ReturnType<typeof refusal> {
  const picked = said(input, field)
  if (picked === undefined) return refusal(field, "Pick the other route")
  return referencedServerId(picked, ROUTE_PREFIX, context, { owns: hasPrefix(ROUTE_PREFIX) }) ?? refusal(field, "Pick a route the API holds")
}

const isOfficeStopService = (value: string): value is OfficeStopService => (OFFICE_STOP_SERVICES as readonly string[]).includes(value)

/** What a stop's fraction is held to when the store holds the row: a waste fraction of the master data. */
const FRACTION_RULE: ReferenceRule = { owns: (record) => masterDataKindOf(record) === "waste-fraction" }

/** The places an address-only stop names, by what the form says it collects at: the field, the web id's prefix, the kind, the sentence a miss is told in. */
const STOP_PLACES: Readonly<Record<string, readonly [string, string, ReferenceRule, string]>> = {
  [STOP_AT_PROPERTY]: ["propertyId", PROPERTY_PREFIX, { owns: isPropertyRecord }, "Pick a property the API holds"],
  [STOP_AT_POINT]: ["sharedCollectionPointId", SHARED_POINT_PREFIX, { owns: isSharedPointRecord }, "Pick a shared collection point the API holds"],
}

/** What a ledger work order books beside its container (O3b of #290), by the field the form names it in: the web id's prefix, the kind, the sentence for none and for one the API does not hold. */
const BOOKINGS: Readonly<Record<BookedField, readonly [string, ReferenceRule, string, string]>> = {
  subscriptionId: [SUBSCRIPTION_PREFIX, { owns: isSubscriptionRecord }, "Pick the subscription it will serve under", "Pick a subscription the API holds"],
  replacementContainerId: ["asset", { owns: containerAdapter.owns }, "Pick the container that replaces it", "Pick a container the API holds"],
  warehouseId: ["warehouse", { owns: warehouseAdapter.owns }, "Pick the warehouse it goes back to", "Pick a warehouse the API holds"],
}

/** The bookings the service names (`BOOKED_WITH`), each by server id, and a delivery's fraction where the form names one; a refusal at the first field that will not do. */
function bookedWith(service: OfficeStopService, input: Record<string, unknown>, context: MappingContext): Record<string, string> | ReturnType<typeof refusal> {
  const body: Record<string, string> = {}
  for (const field of BOOKED_WITH[service]) {
    const [prefix, rule, none, unheld] = BOOKINGS[field]
    const picked = said(input, field)
    if (picked === undefined) return refusal(field, none)
    const serverId = referencedServerId(picked, prefix, context, rule)
    if (serverId === undefined) return refusal(field, unheld)
    body[field] = serverId
  }
  const fraction = service === "deliver" ? said(input, "deliveryFractionId") : undefined
  if (fraction === undefined) return body
  const wasteFractionId = referencedServerId(fraction, "fraction", context, FRACTION_RULE)
  return wasteFractionId === undefined ? refusal("deliveryFractionId", "Pick a waste fraction the API holds") : { ...body, wasteFractionId }
}

/**
 * The body of an added stop (`PickupAdd`): the container alone — with what a
 * delivery, a removal or a swap books beside it — or the one place the form
 * collects at with its fraction, each by server id, and the note where there
 * is one. A field the form hides for another choice is not read, whatever it
 * still holds.
 */
export function addedStopBody(input: Record<string, unknown>, context: MappingContext): Record<string, string> | ReturnType<typeof refusal> {
  const at = said(input, "stopAt") ?? STOP_AT_CONTAINER
  const note = said(input, "note")
  // A bulky booking's collection (O11 of #290): the booking says the place, the fraction and, unless the form gives one, the note.
  if (at === STOP_AT_BULKY_BOOKING) {
    const picked = said(input, "bulkyBookingId")
    const bulkyBookingId = picked === undefined ? undefined : referencedServerId(picked, "bulky-booking", context, { owns: hasPrefix("bulky-booking") })
    if (bulkyBookingId === undefined) return refusal("bulkyBookingId", "Pick a bulky booking of the route's day")
    return { service: "bulky", bulkyBookingId, ...(note === undefined ? {} : { note }) }
  }
  // An emptying is the API's default, so a body says a service only where it is a work order (O3 of #290).
  const service = said(input, "service") ?? "empty"
  if (!isOfficeStopService(service)) return refusal("service", "Book an emptying or one of the work orders offered")
  if (service !== "empty" && at !== STOP_AT_CONTAINER) return refusal("stopAt", A_WORK_ORDER_IS_OF_A_CONTAINER)
  // The ticket the stop is booked to answer (O3c of #290), where Book a stop names one.
  const ticketWebId = said(input, "ticketId")
  const ticketId = ticketWebId === undefined ? undefined : referencedServerId(ticketWebId, "ticket", context, { owns: hasPrefix("ticket") })
  if (ticketWebId !== undefined && ticketId === undefined) return refusal("ticketId", "Pick a ticket the API holds")
  const withNote = (body: Record<string, string>) => ({ ...(service === "empty" ? {} : { service }), ...body, ...(note === undefined ? {} : { note }), ...(ticketId === undefined ? {} : { ticketId }) })
  if (at === STOP_AT_CONTAINER) {
    const picked = said(input, "containerId")
    if (picked === undefined) return refusal("containerId", "Pick the container to collect")
    const containerId = referencedServerId(picked, "asset", context, { owns: containerAdapter.owns })
    if (containerId === undefined) return refusal("containerId", "Pick a container the API holds")
    const booked = bookedWith(service, input, context)
    return isLocalRefusal(booked) ? booked : withNote({ containerId, ...booked })
  }
  const place = STOP_PLACES[at]
  if (place === undefined) return refusal("stopAt", "Collect at a container, a property or a shared collection point")
  const [field, prefix, rule, sentence] = place
  const picked = said(input, field)
  if (picked === undefined) return refusal(field, sentence)
  const placeId = referencedServerId(picked, prefix, context, rule)
  if (placeId === undefined) return refusal(field, sentence)
  const fraction = said(input, "wasteFractionId")
  if (fraction === undefined) return refusal("wasteFractionId", "Name the waste fraction collected there")
  const wasteFractionId = referencedServerId(fraction, "fraction", context, FRACTION_RULE)
  if (wasteFractionId === undefined) return refusal("wasteFractionId", "Pick a waste fraction the API holds")
  return withNote({ [field]: placeId, wasteFractionId })
}

/** What an ad-hoc route may name beside its project and its day: everything an assign moves but the trailer and the service provider, which `RouteCreate` does not take, held as `assign` holds them. */
const CREATED_WITH = ASSIGNED.filter(([field]) => field !== "trailerId" && field !== "serviceProviderId")

/** The route as its own read gives it: the pickups in sequence, the active Plan, the open session and every session, the unloads. */
export function routeDetail(client: Client, serverId: string): Promise<RouteDetail> {
  return get<RouteDetail>(client, `/routes/${serverId}`)
}

/** Every Plan ever asked for over the route, oldest first: the optimiser's, the dispatcher's orders, the measured baselines (O5 of #290). The route's read says which is active. */
export function routePlans(client: Client, serverId: string): Promise<Plan[]> {
  return listAll<Plan>(client, `/routes/${serverId}/plans`)
}

/** Who ordered a Plan's stops, as its history reads it. */
const SOLVER_LABELS: Readonly<Record<Plan["solver"], string>> = {
  optimiser: "Optimised",
  manual: "The dispatcher's order",
  baseline: "Generated order, not optimised",
}

const kilograms = (value: number) => `${new Intl.NumberFormat("en").format(value)} kg`

/**
 * What a route's stops take and weigh (O10 of #290), as its facts say it: the
 * time at the kerb its Duration adds to the drive, and the load its stops are
 * expected to weigh against the planned vehicle's payload — over it, its
 * Plan unloads on the way where it has unload visits (O15 of #290), and the
 * office plans a tip where it has none. Neither where the route has no stop
 * to say it of.
 */
export function workloadFacts(workload: RouteWorkload, unloadsOnTheWay = 0): Record<string, string> {
  const facts: Record<string, string> = {}
  if (workload.stopSeconds > 0) facts["Stop time"] = formatDuration(workload.stopSeconds)
  if (workload.expectedKg !== null) {
    const against = workload.capacityKg === null ? kilograms(workload.expectedKg) : `${kilograms(workload.expectedKg)} of ${kilograms(workload.capacityKg)}`
    const over = workload.overCapacityKg !== null && workload.overCapacityKg > 0 ? `: over by ${kilograms(workload.overCapacityKg)}, ${unloadsOnTheWay > 0 ? "so its Plan unloads on the way" : "plan a tip"}` : ""
    const uncounted = workload.unexpectedStops > 0 ? `, ${workload.unexpectedStops} ${workload.unexpectedStops === 1 ? "stop" : "stops"} not counted` : ""
    facts["Expected load"] = `${against}${over}${uncounted}`
  }
  return facts
}

/** The unload visits a route's Plan makes on the way (O15 of #290), as its facts say them: where the vehicle is full before its last stop, it empties and goes on. */
export const unloadsFact = (visits: number): string => `${visits} ${visits === 1 ? "visit" : "visits"} to the unloading station before the last stop, where the vehicle is full`

/** What the office is told of a stop its Plan holds outside its Service Window (O14 of #290): planned all the same, and the record or the route to look at. */
export const STOP_WARNING_SENTENCES: Readonly<Record<PlanStopWarning, string>> = {
  "windows-disjoint": "its property's access hours and its agreement's service window never overlap, so it was planned without a window",
  "window-unreachable": "no order reached it inside its service window, so it was planned outside it",
}

/**
 * A route's day against its planned driver's shift (O14 of #290), as its
 * facts say it: the shift, and the server's over-shift verdict — within it,
 * or how far the planned day runs outside it — once a Plan is measured.
 * Neither for a driver without a shift on record.
 */
export function shiftFacts(day: RouteShift): Record<string, string> {
  if (day.shift === null) return {}
  const facts: Record<string, string> = { Shift: shiftFact(day.shift) }
  if (day.overShiftSeconds === null || day.workSeconds === null) return facts
  const planned = `${formatDuration(day.workSeconds)} of work from ${day.startsAt ?? day.shift.from}`
  facts["Shift check"] = day.overShiftSeconds > 0 ? `Over shift by ${formatDuration(day.overShiftSeconds)}: ${planned}` : `Within the shift: ${planned}`
  return facts
}

/**
 * One line of a route's Plan history (O5 of #290): when it was asked for on
 * the project's clock, who ordered it, where it stands — its distance and
 * duration once measured, why it failed — and whether it is the one the
 * route runs by.
 */
export function planLine(plan: Pick<Plan, "id" | "createdAt" | "solver" | "status" | "distanceMetres" | "durationSeconds" | "failureReason">, { activePlanId, timezone }: { activePlanId: string | null | undefined; timezone: string | undefined }): string {
  // A Plan measures the drive; the route's Duration adds its stops' time at the kerb (O10 of #290), so the history says which it is.
  const measured = plan.status === "ready" && plan.distanceMetres !== null && plan.durationSeconds !== null ? ` · ${formatDistance(plan.distanceMetres)} · ${formatDuration(plan.durationSeconds)} driving` : ""
  const failed = plan.status === "failed" && plan.failureReason !== null ? ` · ${plan.failureReason}` : ""
  return `${shownOn(plan.createdAt, timezone)} · ${SOLVER_LABELS[plan.solver]} · ${statusLabel(plan.status)}${measured}${failed}${plan.id === activePlanId ? " · Active" : ""}`
}

/** The most routes one bulk dispatch names: the contracts' `DISPATCH_MANY_MAX`, spelled again since the web imports the contracts as types only; routes.test.ts holds the two equal. */
export const DISPATCH_BATCH = 50

/**
 * A day's routes, or a selection, dispatched (O5 of #290): one request per
 * `DISPATCH_BATCH` of them, one after another, and one result per route in
 * the order given, each dispatched or refused with its own dispatch's
 * sentence. Nothing to dispatch asks nothing.
 */
export async function dispatchRoutes(client: Client, routeIds: readonly string[]): Promise<RouteDispatchResults> {
  const results: RouteDispatchResults["results"] = []
  for (let start = 0; start < routeIds.length; start += DISPATCH_BATCH) {
    const answered = await command<RouteDispatchResults>(client, "/routes/dispatch", { routeIds: routeIds.slice(start, start + DISPATCH_BATCH) })
    results.push(...answered.results)
  }
  return { results }
}

/** What the driver's device sent for the route, applied and rejected, oldest first: its command log. */
export function routeCommandLog(client: Client, serverId: string): Promise<DriverCommandReceipt[]> {
  return listAll<DriverCommandReceipt>(client, `/routes/${serverId}/commands`)
}

const CHANGED_BY_COMMANDS = "A route is changed by its commands: assign, dispatch, reschedule, release its hold, cancel, add a stop, move its stops, split or merge it, optimise or reorder its stops"

export const routeAdapter: ResourceAdapter<Route> = {
  prefix: ROUTE_PREFIX,
  owns: ofKind(ROUTE_PREFIX, ["Route"]),
  // Planned, ready, active, completed and cancelled move by the route's commands and the driver's session alone.
  statuses: undefined,
  list: (client) => listAll<Route>(client, "/routes", { from: routesWindowFrom() }),
  toRecord: toRouteRecord,
  // One route read back, as its details show it (O5 of #290): what `refreshRecord` asks once an optimisation's Plan is measured, for the row's distance and duration.
  read: (client, serverId) => routeDetail(client, serverId),
  // New route (#111): an ad-hoc route on a project's day, its references by server id as `assign` names them.
  toCreateBody: (record, context) => {
    const projectId = projectServerIdOf(record, context)
    if (isLocalRefusal(projectId)) return projectId
    const operatingDate = typed(record, "operatingDate")
    if (operatingDate === undefined || !ISO_DAY.test(operatingDate)) return refusal("operatingDate", "A route runs on a day: give its operating date")
    const body: Record<string, string> = { projectId, operatingDate }
    for (const [field, prefix, sentence, rule] of CREATED_WITH) {
      const picked = typed(record, field)
      if (picked === undefined) continue
      const serverId = referencedServerId(picked, prefix, context, rule)
      if (serverId === undefined) return refusal(field, sentence)
      body[field] = serverId
    }
    const note = typed(record, "note")
    return note === undefined ? body : { ...body, note }
  },
  create: async (client, body) => (await create<RouteDetail>(client, "/routes", body)).body,
  toPatchBody: () => refusal("", CHANGED_BY_COMMANDS),
  update: () => Promise.reject(new Error(CHANGED_BY_COMMANDS)),
  commands: ROUTE_COMMANDS,
}

/** Route Studio › Routes: the dated routes generation wrote and the office's own, moved by the dispatcher's commands. */
export const routesModule: ServerModule = {
  workspaceId: ROUTES_MODULE.workspaceId,
  moduleId: ROUTES_MODULE.moduleId,
  resources: [routeAdapter],
}

export type { Client }
