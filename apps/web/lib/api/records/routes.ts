// Routes on the prototype's records (Issue #179, slice 6 of #81): the dated
// Route generation wrote, as the rows of `route-studio.routes` — the table,
// the map's Routes layer and the route's details read them. The wire shapes
// are the contracts' (`@waste/contracts/routes`), imported as types so no zod
// reaches the bundle; the routes are apps/api/src/routes/routes.ts.
//
// A route is never created or edited here: generation writes it (the office
// asks for a run on its scheme, the nightly sweep runs on its own), and the
// dispatcher moves it by five commands — `assign` the Planned Assignment,
// `dispatch` it to its driver, `reschedule` the day it runs or its planned
// start (never its service date, the identity), `cancel` it with a reason,
// which becomes its note, and put its open stops in order (`PUT
// /routes/:id/pickup-order`, a manual Plan). So the adapter lists no
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
import type { Route, RouteDetail } from "@waste/contracts/routes"

import { FIXTURE_COMPANY_ID, type BusinessRecord, type ModuleLocation } from "@/lib/data/business-modules"
import { ROUTE_ACTIVE_PLAN_KEY } from "@/lib/data/routes"

import { command, get, listAll, put } from "../client"
import { hasPrefix, inheritedPresentation, ofKind, stampFacts, statusLabel, typed, webIdOf, type Client, type CommandInput, type MappingContext, type RecordCommand, type ResourceAdapter, type ServerModule } from "./adapter"
import { shownOn } from "./clock"
import { driverAdapter, vehicleAdapter } from "./fleet"
import { depotAdapter, referenced, refusal, unloadingStationAdapter } from "./places"
import { nameVia, referencedServerId, webIdVia, type ReferenceRule } from "./references"

/** The workspace module the routes are the rows of. */
export const ROUTES_MODULE: ModuleLocation = { workspaceId: "route-studio", moduleId: "routes" }

/** The route's commands, by the names the surfaces send. */
export const ASSIGN_ROUTE = "assign"
export const DISPATCH_ROUTE = "dispatch"
export const RESCHEDULE_ROUTE = "reschedule"
export const CANCEL_ROUTE = "cancel"
export const REORDER_ROUTE = "reorder"

const ROUTE_PREFIX = "route"
const SCHEME_PREFIX = "scheme"
const GROUP_PREFIX = "group"
const PICKUP_PREFIX = "pickup"

/** A route as a read may carry it: the list's, or the detail's and the live read's with the active Plan. */
type RouteRead = Route & { activePlan?: RouteDetail["activePlan"] }

/** "WH-24" for "WH-24 · CN 42 018": a vehicle as the fixtures and the map name it, its callsign; an id chip as it stands. */
const callsignOf = (name: string) => name.split(" · ")[0] ?? name

/** A dialog value as a non-blank string, or undefined. */
function said(input: CommandInput, key: string): string | undefined {
  const value = input[key]
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
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

export function toRouteRecord(route: RouteRead, context: MappingContext): BusinessRecord {
  const project = projectOf(route, context)
  const at = (instant: string | null) => (instant === null ? undefined : shownOn(instant, project.timezone))
  const vehicle = route.planned.vehicleId === null ? undefined : callsignOf(nameVia(context, "vehicle", route.planned.vehicleId))
  const driver = route.planned.driverId === null ? undefined : nameVia(context, "driver", route.planned.driverId)
  const trailer = route.planned.trailerId === null ? undefined : callsignOf(nameVia(context, "vehicle", route.planned.trailerId))
  const scheme = context.resolve.byServerId(route.routeSchemeId)
  // The route carries no area on the wire: it is filed under its scheme's, once the schemes are loaded (#177).
  const area = scheme?.facts["Planning area"]
  const facts: Record<string, string> = {
    Project: project.name ?? project.webId,
    ...(area === undefined ? {} : { Area: area }),
    "Route scheme": nameVia(context, SCHEME_PREFIX, route.routeSchemeId),
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
  facts.Deviation = route.note ?? "None"
  const stamps: Array<[string, string | undefined]> = [
    ["Dispatched at", at(route.dispatchedAt)],
    ["Started at", at(route.startedAt)],
    ["Completed at", at(route.completedAt)],
    ["Cancelled at", at(route.cancelledAt)],
  ]
  for (const [fact, value] of stamps) if (value !== undefined) facts[fact] = value
  if (route.actual.driverId !== null || route.actual.vehicleId !== null) {
    facts["Actual assignment"] = [
      route.actual.driverId === null ? undefined : nameVia(context, "driver", route.actual.driverId),
      route.actual.vehicleId === null ? undefined : callsignOf(nameVia(context, "vehicle", route.actual.vehicleId)),
      route.actual.trailerId === null ? undefined : callsignOf(nameVia(context, "vehicle", route.actual.trailerId)),
    ]
      .filter(Boolean)
      .join(" · ")
  }
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
    description: `Generated from ${scheme?.name ?? "its route scheme"} for ${route.serviceDate}${route.operatingDate === route.serviceDate ? "" : `, running ${route.operatingDate}`}.`,
    facts,
    companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
    projectIds: [project.webId],
    ...(route.planned.serviceProviderId === null ? {} : { serviceProviderId: webIdVia(context, "service-provider", route.planned.serviceProviderId) }),
    recordKind: "Route",
    submittedValues: {
      projectId: project.webId,
      schemeId: webIdVia(context, SCHEME_PREFIX, route.routeSchemeId),
      collectionGroupId: webIdVia(context, GROUP_PREFIX, route.collectionGroupId),
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

/** What an assign may move: the field, the id chip's prefix, the sentence a miss is refused in, the kind a loaded row is held to. */
const ASSIGNED: ReadonlyArray<readonly [string, string, string, ReferenceRule]> = [
  ["vehicleId", "vehicle", "Pick a vehicle the API holds", { owns: vehicleAdapter.owns }],
  ["driverId", "driver", "Pick a driver the API holds", { owns: driverAdapter.owns }],
  ["trailerId", "vehicle", "Pick a trailer the API holds", { owns: vehicleAdapter.owns }],
  ["depotId", "depot", "Pick a depot the API holds", { owns: depotAdapter.owns }],
  ["unloadingStationId", "station", "Pick an unloading station the API holds", { owns: unloadingStationAdapter.owns }],
]

const NOTHING_TO_ASSIGN = "Nothing to assign: pick another vehicle, driver, trailer, depot or unloading station"
const NOTHING_TO_RESCHEDULE = "Nothing to reschedule: move the day it runs or its planned start"
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/

/** A command posted to its path on the route. */
const onRoute = (path: string, verb: string, toBody?: RecordCommand<Route>["toBody"]): RecordCommand<Route> => ({
  ...(toBody === undefined ? {} : { toBody }),
  run: (client, serverId, body) => command<RouteDetail>(client, `/routes/${serverId}/${path}`, body),
  refused: (record) => `${record.name} was not ${verb}`,
})

export const ROUTE_COMMANDS = {
  [ASSIGN_ROUTE]: onRoute("assign", "assigned", (input, record, context) => {
    const body: Record<string, string | null> = {}
    for (const [field, prefix, sentence, rule] of ASSIGNED) {
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
  [RESCHEDULE_ROUTE]: onRoute("reschedule", "rescheduled", (input, record) => {
    const day = said(input, "operatingDate")
    const start = said(input, "plannedStartTime")
    if (day === undefined) return refusal("operatingDate", "A route runs on a day: give its operating date")
    if (!ISO_DAY.test(day)) return refusal("operatingDate", "Give the day it runs as a date")
    if (start !== undefined && !CLOCK_TIME.test(start)) return refusal("plannedStartTime", "Give the planned start as HH:MM")
    const body: { operatingDate?: string; plannedStartTime?: string | null } = {}
    if (day !== typed(record, "operatingDate")) body.operatingDate = day
    if (start !== typed(record, "plannedStartTime")) body.plannedStartTime = start ?? null
    return Object.keys(body).length === 0 ? refusal("operatingDate", NOTHING_TO_RESCHEDULE) : body
  }),
  [CANCEL_ROUTE]: onRoute("cancel", "cancelled", (input) => {
    const reason = said(input, "reason")
    return reason === undefined ? refusal("reason", "Say why the route is cancelled") : { reason }
  }),
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
  },
} satisfies Record<string, RecordCommand<Route>>

/** The route as its own read gives it: the pickups in sequence, the active Plan, the open session and every session, the unloads. */
export function routeDetail(client: Client, serverId: string): Promise<RouteDetail> {
  return get<RouteDetail>(client, `/routes/${serverId}`)
}

/** What the driver's device sent for the route, applied and rejected, oldest first: its command log. */
export function routeCommandLog(client: Client, serverId: string): Promise<DriverCommandReceipt[]> {
  return listAll<DriverCommandReceipt>(client, `/routes/${serverId}/commands`)
}

const CHANGED_BY_COMMANDS = "A route is changed by its commands: assign, dispatch, reschedule, cancel or reorder its stops"

export const routeAdapter: ResourceAdapter<Route> = {
  prefix: ROUTE_PREFIX,
  owns: ofKind(ROUTE_PREFIX, ["Route"]),
  // Planned, ready, active, completed and cancelled move by the route's commands and the driver's session alone.
  statuses: undefined,
  list: (client) => listAll<Route>(client, "/routes"),
  toRecord: toRouteRecord,
  toPatchBody: () => refusal("", CHANGED_BY_COMMANDS),
  update: () => Promise.reject(new Error(CHANGED_BY_COMMANDS)),
  commands: ROUTE_COMMANDS,
}

/** Route Studio › Routes: the dated routes generation wrote, moved by the dispatcher's commands. */
export const routesModule: ServerModule = {
  workspaceId: ROUTES_MODULE.workspaceId,
  moduleId: ROUTES_MODULE.moduleId,
  resources: [routeAdapter],
}

export type { Client }
