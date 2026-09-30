// Vehicle allocations on the prototype's records (Issue #181, slice 5b of
// #81): the current reservation of a vehicle — and a driver, a trailer, a
// depot, a fraction — over a window, as the rows of `fleet.vehicle-planning`.
// The wire shapes are the contracts' (`@waste/contracts/allocations`),
// imported as types so no zod reaches the bundle; the route is
// apps/api/src/routes/vehicle-allocations.ts.
//
// An allocation is never edited by a form on the wire: `allocate` is the
// create, `change` carries every field a planner may move and the reason,
// which is the event's, and `confirm` and `release` move the status. So the
// adapter's edit is the change command — a patch of what moved, and the
// form's `changeReason`, refused here without one — and the status is the
// row's commands alone: the adapter lists no `statuses`, and the store
// refuses a status an edit moves. A released allocation changes no more; the
// API says so in its own 409.
//
// The window is two instants on the wire and a wall-clock time in the form
// (`YYYY-MM-DDTHH:mm`, the prototype's `plannedStart`/`plannedEnd`, which the
// scheme-save conflict check reads, Issue #11), read on the project's clock:
// 05:30 in Copenhagen is 03:30Z in summer and 04:30Z in winter, whatever the
// browser's timezone. A project the store does not hold falls back on the
// browser's clock.
//
// Relations by web id through the store's resolver: the project, and the
// fraction (master data) by name; the vehicle, the trailer, the driver and
// the depot by label once 5a's modules have loaded, and as id chips until
// then. An allocation names no work: no route and no group, its purpose is
// its note.
import type { VehicleAllocation, VehicleAllocationEvent } from "@waste/contracts/allocations"

import { FIXTURE_COMPANY_ID, type BusinessRecord, type ModuleLocation } from "@/lib/data/business-modules"
import { masterDataKindOf } from "@/lib/data/master-data"

import { command, create, listAll } from "../client"
import { inheritedPresentation, isLocalRefusal, ofKind, patchOf, stampFacts, statusLabel, typed, webIdOf, type Client, type LocalRefusal, type MappingContext, type RecordCommand, type ResourceAdapter, type ServerModule } from "./adapter"
import { instantOn, projectTimezoneOf, wallClockIn } from "./clock"
import { driverAdapter, vehicleAdapter } from "./fleet"
import { depotAdapter, projectMoved, refusal } from "./places"
import { nameVia, typedReference, webIdVia, type ReferenceRule } from "./references"

/** The workspace module the allocations are the rows of. */
export const VEHICLE_PLANNING_MODULE: ModuleLocation = { workspaceId: "fleet", moduleId: "vehicle-planning" }

/** The row's commands, by the names the dialogs send. */
export const CONFIRM_ALLOCATION = "confirm"
export const RELEASE_ALLOCATION = "release"

const ALLOCATION_PREFIX = "allocation"

/** "1 Oct" for a wall-clock time, as the fixtures name an allocation's day. */
const dayLabel = (wall: string) => new Date(`${wall.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })

// ---------------------------------------------------------------------------
// The record, and the bodies it becomes
// ---------------------------------------------------------------------------

/** The project a record is in, and its clock. */
function projectOf(record: BusinessRecord, context: MappingContext): { webId: string | undefined; serverId: string | undefined; timezone: string | undefined } {
  const webId = typed(record, "projectId") ?? record.projectIds?.[0]
  const serverId = webId === undefined ? undefined : context.resolve.serverIdOf(webId)
  return { webId, serverId, timezone: projectTimezoneOf(record, context) }
}

// Each reference field: the prefix its id chip carries, the sentence a miss is refused in, and the kind a loaded row is held to.
const isFraction = (record: BusinessRecord) => masterDataKindOf(record) === "waste-fraction"
/** The fleet's and the depot's id chips a dialog may name — the prefix, the refusal a miss is told in, the kind a loaded row is held to — shared with the routes' assign (routes.ts, #179). */
export const FLEET_AND_DEPOT_PICKS = {
  vehicleId: ["vehicle", "Pick a vehicle the API holds", { owns: vehicleAdapter.owns }],
  driverId: ["driver", "Pick a driver the API holds", { owns: driverAdapter.owns }],
  trailerId: ["vehicle", "Pick a trailer the API holds", { owns: vehicleAdapter.owns }],
  depotId: ["depot", "Pick a depot the API holds", { owns: depotAdapter.owns }],
} as const satisfies Record<string, readonly [string, string, ReferenceRule]>

const PICK = {
  ...FLEET_AND_DEPOT_PICKS,
  plannedFraction: ["fraction", "Pick a waste fraction the API holds", { owns: isFraction }],
} as const satisfies Record<string, readonly [string, string, ReferenceRule]>
type ReferenceField = keyof typeof PICK

const WIRE_MEMBERS: Readonly<Record<ReferenceField, string>> = { vehicleId: "vehicleId", driverId: "driverId", trailerId: "trailerId", depotId: "depotId", plannedFraction: "wasteFractionId" }

const CAPACITY = "Required capacity is whole kilograms, 1 or more"

/** The required capacity the form says, in kilograms; undefined when blank. */
function capacityOf(record: BusinessRecord): number | undefined | LocalRefusal {
  const value = typed(record, "requiredCapacity")
  if (value === undefined) return undefined
  return /^\d+$/.test(value) && Number(value) >= 1 ? Number(value) : refusal("requiredCapacity", CAPACITY)
}

/** The window the form says, as the wire's two instants, or the refusal naming the bound that is wrong. */
function windowOf(record: BusinessRecord, timezone: string | undefined): { plannedFrom: string; plannedTo: string } | LocalRefusal {
  const start = typed(record, "plannedStart")
  const end = typed(record, "plannedEnd")
  if (start === undefined) return refusal("plannedStart", "Give the planned start")
  if (end === undefined) return refusal("plannedEnd", "Give the planned end")
  const plannedFrom = instantOn(start, timezone)
  if (plannedFrom === undefined) return refusal("plannedStart", "Give the planned start as a date and a time")
  const plannedTo = instantOn(end, timezone)
  if (plannedTo === undefined) return refusal("plannedEnd", "Give the planned end as a date and a time")
  return Date.parse(plannedTo) > Date.parse(plannedFrom) ? { plannedFrom, plannedTo } : refusal("plannedEnd", "The planned end comes after the planned start")
}

/** Every reference the form names, as the wire's members, or the first refusal. */
function referencesOf(record: BusinessRecord, context: MappingContext): Record<string, string | null> | LocalRefusal {
  const body: Record<string, string | null> = {}
  for (const field of Object.keys(PICK) as ReferenceField[]) {
    const [prefix, refused, rule] = PICK[field]
    const id = typedReference(record, field, prefix, context, refused, rule)
    if (isLocalRefusal(id)) return id
    body[WIRE_MEMBERS[field]] = id ?? null
  }
  return body
}

/** What a change may move, read off a record for `patchOf`: the references by server id, the capacity, the window, the note. */
function changeableOf(record: BusinessRecord, context: MappingContext, timezone: string | undefined): Record<string, unknown> {
  const references = referencesOf(record, context)
  const capacity = capacityOf(record)
  const start = typed(record, "plannedStart")
  const end = typed(record, "plannedEnd")
  return {
    ...(isLocalRefusal(references) ? {} : references),
    requiredCapacityKg: isLocalRefusal(capacity) ? undefined : (capacity ?? null),
    plannedFrom: start === undefined ? undefined : instantOn(start, timezone),
    plannedTo: end === undefined ? undefined : instantOn(end, timezone),
    note: typed(record, "note") ?? null,
  }
}

export const allocationAdapter: ResourceAdapter<VehicleAllocation> = {
  prefix: ALLOCATION_PREFIX,
  owns: ofKind(ALLOCATION_PREFIX, ["Vehicle allocation"]),
  // Planned, confirmed and released move by the row's commands alone.
  statuses: undefined,
  list: (client) => listAll<VehicleAllocation>(client, "/vehicle-allocations"),
  toRecord: (allocation, context) => {
    const project = context.resolve.byServerId(allocation.projectId)
    const projectWebId = project?.id ?? webIdOf("project", allocation.projectId)
    const timezone = project === undefined ? undefined : typed(project, "timezone")
    const start = wallClockIn(allocation.plannedFrom, timezone)
    const end = wallClockIn(allocation.plannedTo, timezone)
    const vehicle = nameVia(context, "vehicle", allocation.vehicleId)
    const driver = allocation.driverId === null ? undefined : nameVia(context, "driver", allocation.driverId)
    const capacity = allocation.requiredCapacityKg === null ? "" : `${allocation.requiredCapacityKg.toLocaleString("en-GB")} kg`
    const facts: Record<string, string> = {
      Vehicle: vehicle,
      Driver: driver ?? "No driver",
      Window: `${start.replace("T", " ")} – ${end.replace("T", " ")}`,
      Project: project?.name ?? projectWebId,
    }
    if (allocation.trailerId !== null) facts.Trailer = nameVia(context, "vehicle", allocation.trailerId)
    if (allocation.depotId !== null) facts.Depot = nameVia(context, "depot", allocation.depotId)
    if (allocation.wasteFractionId !== null) facts["Waste fraction"] = nameVia(context, "fraction", allocation.wasteFractionId)
    if (capacity !== "") facts["Required capacity"] = capacity
    if (allocation.note !== null) facts.Note = allocation.note
    return {
      id: webIdOf(ALLOCATION_PREFIX, allocation.id),
      name: `${dayLabel(start)} · ${vehicle}`,
      context: `${driver ?? "No driver"} · ${start.slice(11)}–${end.slice(11)}`,
      status: statusLabel(allocation.status),
      ...inheritedPresentation(undefined),
      ...stampFacts(allocation, context.now),
      value: capacity,
      description: "A time-bounded reservation of a vehicle, and where it applies a driver, for expected work.",
      facts,
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: [projectWebId],
      recordKind: "Vehicle allocation",
      submittedValues: {
        projectId: projectWebId,
        vehicleId: webIdVia(context, "vehicle", allocation.vehicleId),
        driverId: allocation.driverId === null ? "" : webIdVia(context, "driver", allocation.driverId),
        trailerId: allocation.trailerId === null ? "" : webIdVia(context, "vehicle", allocation.trailerId),
        depotId: allocation.depotId === null ? "" : webIdVia(context, "depot", allocation.depotId),
        plannedFraction: allocation.wasteFractionId === null ? "" : webIdVia(context, "fraction", allocation.wasteFractionId),
        requiredCapacity: allocation.requiredCapacityKg === null ? "" : String(allocation.requiredCapacityKg),
        plannedStart: start,
        plannedEnd: end,
        allocationStatus: allocation.status,
        note: allocation.note ?? "",
        changeReason: "",
      },
    }
  },
  toCreateBody: (record, context) => {
    const project = projectOf(record, context)
    if (project.serverId === undefined) return refusal("projectId", "Pick a project")
    if (typed(record, "vehicleId") === undefined) return refusal("vehicleId", PICK.vehicleId[1])
    const references = referencesOf(record, context)
    if (isLocalRefusal(references)) return references
    const capacity = capacityOf(record)
    if (isLocalRefusal(capacity)) return capacity
    const window = windowOf(record, project.timezone)
    if (isLocalRefusal(window)) return window
    const status = typed(record, "allocationStatus")
    if (status === "released") return refusal("allocationStatus", "An allocation is released by its release command")
    const note = typed(record, "note")
    return {
      projectId: project.serverId,
      ...Object.fromEntries(Object.entries(references).filter(([, id]) => id !== null)),
      ...(capacity === undefined ? {} : { requiredCapacityKg: capacity }),
      ...window,
      // The prototype's Draft and Allocated are the wire's planned, which is its default.
      ...(status === "confirmed" ? { status } : {}),
      ...(note === undefined ? {} : { note }),
    }
  },
  toPatchBody: (before, after, context) => {
    const project = projectOf(before, context)
    if (projectMoved(before, after)) return refusal("projectId", "An allocation stays in its project")
    const references = referencesOf(after, context)
    if (isLocalRefusal(references)) return references
    const capacity = capacityOf(after)
    if (isLocalRefusal(capacity)) return capacity
    const window = windowOf(after, project.timezone)
    if (isLocalRefusal(window)) return window
    const moved = patchOf(before, after, (record) => changeableOf(record, context, project.timezone))
    if (moved === null) return null
    const reason = typed(after, "changeReason")
    if (reason === undefined) return refusal("changeReason", "Say why it changes")
    return { ...moved, reason }
  },
  create: (client, body) => create<VehicleAllocation>(client, "/vehicle-allocations", body).then((created) => created.body),
  // An allocation has no PATCH: an edit is the change command, with its reason.
  update: (client, serverId, body) => command<VehicleAllocation>(client, `/vehicle-allocations/${serverId}/change`, body),
  commands: {
    [CONFIRM_ALLOCATION]: {
      // The body is empty, and the contract refuses a member in it.
      toBody: () => ({}),
      run: (client, serverId, body) => command<VehicleAllocation>(client, `/vehicle-allocations/${serverId}/confirm`, body),
      refused: (record) => `${record.name} was not confirmed`,
    },
    [RELEASE_ALLOCATION]: {
      toBody: (input) => {
        const reason = typeof input.reason === "string" ? input.reason.trim() : ""
        return reason === "" ? refusal("reason", "Say why it is released") : { reason }
      },
      run: (client, serverId, body) => command<VehicleAllocation>(client, `/vehicle-allocations/${serverId}/release`, body),
      refused: (record) => `${record.name} was not released`,
    },
  } satisfies Record<string, RecordCommand<VehicleAllocation>>,
}

/** One allocation's history, oldest first: every action, the status after it, the snapshot it left and the reason. */
export function allocationEvents(client: Client, serverId: string): Promise<VehicleAllocationEvent[]> {
  return listAll<VehicleAllocationEvent>(client, `/vehicle-allocations/${serverId}/events`)
}

/** Fleet › Vehicle Planning: the allocations, after the fleet and the master data they name. */
export const vehiclePlanningModule: ServerModule = {
  workspaceId: VEHICLE_PLANNING_MODULE.workspaceId,
  moduleId: VEHICLE_PLANNING_MODULE.moduleId,
  resources: [allocationAdapter],
}
