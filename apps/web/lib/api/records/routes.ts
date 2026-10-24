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
import type { DriverCommandReceipt } from "@waste/contracts/driver-commands"
import type { PickupDetail } from "@waste/contracts/pickups"
import type { Route, RouteDetail } from "@waste/contracts/routes"

import { FIXTURE_COMPANY_ID, type BusinessRecord, type ModuleLocation } from "@/lib/data/business-modules"
import { PROPERTY_PREFIX, SHARED_POINT_PREFIX } from "@/lib/data/agreements"
import { masterDataKindOf } from "@/lib/data/master-data"
import { isPropertyRecord, isSharedPointRecord } from "@/lib/data/properties"
import { ROUTE_ACTIVE_PLAN_KEY, STOP_AT_CONTAINER, STOP_AT_POINT, STOP_AT_PROPERTY } from "@/lib/data/routes"

import { command, create, get, listAll, put } from "../client"
import { hasPrefix, inheritedPresentation, isLocalRefusal, moduleKeyOf, ofKind, said, stampFacts, statusLabel, typed, webIdOf, type Client, type MappingContext, type RecordCommand, type ResourceAdapter, type ServerModule } from "./adapter"
import { FLEET_AND_DEPOT_PICKS } from "./allocations"
import { shownOn } from "./clock"
import { containerAdapter } from "./containers"
import { projectServerIdOf, referenced, refusal, unloadingStationAdapter } from "./places"
import { nameVia, referencedServerId, webIdVia, type ReferenceRule } from "./references"

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
const PICKUPS_KEY = moduleKeyOf(ROUTES_MODULE.workspaceId, "pickups")

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

/** What an ad-hoc route says it is, under its Origin fact (#111): the office's own, with no scheme. */
export const MADE_BY_THE_OFFICE = "Made by the office"

const ROUTE_PREFIX = "route"
const SCHEME_PREFIX = "scheme"
const GROUP_PREFIX = "group"
const PICKUP_PREFIX = "pickup"

/** A route as a read may carry it: the list's, or the detail's and the live read's with the active Plan. */
type RouteRead = Route & { activePlan?: RouteDetail["activePlan"] }

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
      depotId: reference("depot", route.planned.depotId),
      unloadingStationId: reference("station", route.planned.unloadingStationId),
      status: route.status,
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

/** What an assign may move — the field, the id chip's prefix, the sentence a miss is refused in, the kind a loaded row is held to: the fleet's and the depot's chips as the allocations name them (allocations.ts), and the unloading station. */
const ASSIGNED: ReadonlyArray<readonly [string, string, string, ReferenceRule]> = [
  ...(Object.entries(FLEET_AND_DEPOT_PICKS) as ReadonlyArray<[string, readonly [string, string, ReferenceRule]]>).map(([field, [prefix, sentence, rule]]) => [field, prefix, sentence, rule] as const),
  ["unloadingStationId", "station", "Pick an unloading station the API holds", { owns: unloadingStationAdapter.owns }],
]

const NOTHING_TO_ASSIGN = "Nothing to assign: pick another vehicle, driver, trailer, depot or unloading station"
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
    const body: { operatingDate?: string; plannedStartTime?: string | null } = {}
    if (day !== typed(record, "operatingDate")) body.operatingDate = day
    if (start !== typed(record, "plannedStartTime")) body.plannedStartTime = start ?? null
    return Object.keys(body).length === 0 ? refusal("operatingDate", NOTHING_TO_RESCHEDULE) : body
  }),
  [CANCEL_ROUTE]: onRoute(
    "cancel",
    "cancelled",
    (input) => {
      const reason = said(input, "reason")
      return reason === undefined ? refusal("reason", "Say why the route is cancelled") : { reason }
    },
    [PICKUPS_KEY, LIVE_KEY],
  ),
  // A stop of the office's own (#111): a container, or an address with the fraction collected there. The API answers the stop; the route is read back for the row, its stops and its progress.
  [ADD_STOP]: {
    toBody: (input, _record, context) => addedStopBody(input, context),
    run: async (client, serverId, body) => {
      await create<PickupDetail>(client, `/routes/${serverId}/pickups`, body)
      return routeDetail(client, serverId)
    },
    refused: (record) => `No stop was added to ${record.name}`,
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
} satisfies Record<string, RecordCommand<Route>>

/** What a stop's fraction is held to when the store holds the row: a waste fraction of the master data. */
const FRACTION_RULE: ReferenceRule = { owns: (record) => masterDataKindOf(record) === "waste-fraction" }

/** The places an address-only stop names, by what the form says it collects at: the field, the web id's prefix, the kind, the sentence a miss is told in. */
const STOP_PLACES: Readonly<Record<string, readonly [string, string, ReferenceRule, string]>> = {
  [STOP_AT_PROPERTY]: ["propertyId", PROPERTY_PREFIX, { owns: isPropertyRecord }, "Pick a property the API holds"],
  [STOP_AT_POINT]: ["sharedCollectionPointId", SHARED_POINT_PREFIX, { owns: isSharedPointRecord }, "Pick a shared collection point the API holds"],
}

/**
 * The body of an added stop (`PickupAdd`): the container alone, or the one
 * place the form collects at with its fraction, each by server id, and the
 * note where there is one. A field the form hides for another choice is not
 * read, whatever it still holds.
 */
export function addedStopBody(input: Record<string, unknown>, context: MappingContext): Record<string, string> | ReturnType<typeof refusal> {
  const at = said(input, "stopAt") ?? STOP_AT_CONTAINER
  const note = said(input, "note")
  const withNote = (body: Record<string, string>) => (note === undefined ? body : { ...body, note })
  if (at === STOP_AT_CONTAINER) {
    const picked = said(input, "containerId")
    if (picked === undefined) return refusal("containerId", "Pick the container to collect")
    const containerId = referencedServerId(picked, "asset", context, { owns: containerAdapter.owns })
    return containerId === undefined ? refusal("containerId", "Pick a container the API holds") : withNote({ containerId })
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

/** What an ad-hoc route may name beside its project and its day: everything an assign moves but the trailer, which `RouteCreate` does not take, held as `assign` holds them. */
const CREATED_WITH = ASSIGNED.filter(([field]) => field !== "trailerId")

/** The route as its own read gives it: the pickups in sequence, the active Plan, the open session and every session, the unloads. */
export function routeDetail(client: Client, serverId: string): Promise<RouteDetail> {
  return get<RouteDetail>(client, `/routes/${serverId}`)
}

/** What the driver's device sent for the route, applied and rejected, oldest first: its command log. */
export function routeCommandLog(client: Client, serverId: string): Promise<DriverCommandReceipt[]> {
  return listAll<DriverCommandReceipt>(client, `/routes/${serverId}/commands`)
}

const CHANGED_BY_COMMANDS = "A route is changed by its commands: assign, dispatch, reschedule, release its hold, cancel, add a stop or reorder its stops"

export const routeAdapter: ResourceAdapter<Route> = {
  prefix: ROUTE_PREFIX,
  owns: ofKind(ROUTE_PREFIX, ["Route"]),
  // Planned, ready, active, completed and cancelled move by the route's commands and the driver's session alone.
  statuses: undefined,
  list: (client) => listAll<Route>(client, "/routes", { from: routesWindowFrom() }),
  toRecord: toRouteRecord,
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
