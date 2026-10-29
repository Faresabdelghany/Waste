// Pre-trip inspection (O13 of #290): a vehicle type's checklist, the checks
// drivers append through their door, and the defects the office mends.
//
// The checklist rides on the vehicle type (routes/vehicle-types.ts reads it
// through `checklistsOf` and replaces it through `replaceChecklist`), and the
// driver door reads the one of the vehicle a `pre-trip-check` names
// (`checklistOfVehicle`) and the ones of the vehicles its start screen offers.
// The check itself is the door's effect (`appendPreTripCheck`), in the
// command's savepoint: the ledger row under the command's id, and where the
// check found defects, one `vehicle_defect` row each, the office's ticket for
// them — one per check, `vehicle-defect`, in the domain's sentences on the
// project's clock, due by the project's SLA — and, where a defect is
// critical, the vehicle set to `maintenance`, which the start rule refuses a
// route on. The status moves only from `active`, the status `decide` judged
// the check on; a vehicle the office moved meanwhile keeps the office's.
//
// Three routes under `fleet.vehicles`: the checks and the defects of the
// caller's projects, each a page narrowed to a vehicle, and a defect's
// resolve — the office saying it is mended, with a note. Resolving leaves the
// vehicle's status alone: setting it active again is the vehicle's own edit,
// since one defect mended is not every defect mended.
import { routeLabel } from "@waste/contracts/execution"
import type { FlatPoint } from "@waste/contracts/geojson"
import { Page } from "@waste/contracts/pagination"
import { PreTripCheck, PreTripCheckListQuery, VehicleDefect, VehicleDefectListQuery, VehicleDefectResolve, type ChecklistItem, type CheckedItem, type VehicleDefectStatus } from "@waste/contracts/pre-trip"
import type { Tx } from "@waste/db/client"
import { vehicle } from "@waste/db/schema/fleet"
import { project } from "@waste/db/schema/organisation"
import { preTripCheck, preTripChecklistItem, vehicleDefect } from "@waste/db/schema/pre-trip"
import type { PreTripCheckDraft } from "@waste/domain/execution/commands"
import { defectTicket } from "@waste/domain/resources/pre-trip"
import { and, asc, eq, gt, inArray } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { vehicleLabel } from "./fleet-lookups"
import { describeJson, IdParam, instantOf, lockRow, stamp, stampsOf } from "./shared"
import { whenOn } from "./ticket-evidence"
import { BY_SLA, openTicket } from "./ticket-writes"

const VEHICLES = "fleet.vehicles"
const PreTripCheckPage = Page(PreTripCheck)
const VehicleDefectPage = Page(VehicleDefect)

/** What a resolve of a defect already resolved is told. */
export const alreadyResolved = (label: string): string => `The defect ${label} is already resolved`

const noSuchDefect = (id: string) => problem(404, { detail: `No vehicle defect ${id} in the projects this account works in` })

// The checklist.

/** The checklists of the given vehicle types, in one query, by type id, each in its order; a type with none is absent. */
export async function checklistsOf(tx: Tx, companyId: string, typeIds: readonly string[]): Promise<Map<string, ChecklistItem[]>> {
  const byType = new Map<string, ChecklistItem[]>()
  if (typeIds.length === 0) return byType
  const rows = await tx
    .select({ vehicleTypeId: preTripChecklistItem.vehicleTypeId, id: preTripChecklistItem.id, label: preTripChecklistItem.label, critical: preTripChecklistItem.critical })
    .from(preTripChecklistItem)
    .where(and(eq(preTripChecklistItem.companyId, companyId), inArray(preTripChecklistItem.vehicleTypeId, [...typeIds])))
    .orderBy(asc(preTripChecklistItem.vehicleTypeId), asc(preTripChecklistItem.position))
  for (const { vehicleTypeId, ...item } of rows) byType.set(vehicleTypeId, [...(byType.get(vehicleTypeId) ?? []), item])
  return byType
}

/** The checklist of a vehicle's type, in order: what a `pre-trip-check` of it answers. */
export async function checklistOfVehicle(tx: Tx, companyId: string, vehicleId: string): Promise<ChecklistItem[]> {
  return await tx
    .select({ id: preTripChecklistItem.id, label: preTripChecklistItem.label, critical: preTripChecklistItem.critical })
    .from(preTripChecklistItem)
    .innerJoin(vehicle, and(eq(vehicle.companyId, preTripChecklistItem.companyId), eq(vehicle.vehicleTypeId, preTripChecklistItem.vehicleTypeId)))
    .where(and(eq(preTripChecklistItem.companyId, companyId), eq(vehicle.id, vehicleId)))
    .orderBy(asc(preTripChecklistItem.position))
}

/** Replaces a type's checklist whole, minting new ids in the body's order; the caller holds the type's row. */
export async function replaceChecklist(tx: Tx, companyId: string, vehicleTypeId: string, items: readonly { label: string; critical: boolean }[]): Promise<ChecklistItem[]> {
  await tx.delete(preTripChecklistItem).where(and(eq(preTripChecklistItem.companyId, companyId), eq(preTripChecklistItem.vehicleTypeId, vehicleTypeId)))
  if (items.length === 0) return []
  return await tx
    .insert(preTripChecklistItem)
    .values(items.map((item, index) => ({ id: newId(), companyId, vehicleTypeId, position: index + 1, label: item.label.trim(), critical: item.critical })))
    .returning({ id: preTripChecklistItem.id, label: preTripChecklistItem.label, critical: preTripChecklistItem.critical })
}

// The check.

const checkColumns = {
  id: preTripCheck.id,
  projectId: preTripCheck.projectId,
  recordedAt: preTripCheck.recordedAt,
  routeId: preTripCheck.routeId,
  vehicleId: preTripCheck.vehicleId,
  driverId: preTripCheck.driverId,
  occurredAt: preTripCheck.occurredAt,
  items: preTripCheck.items,
  defectCount: preTripCheck.defectCount,
  odometerKm: preTripCheck.odometerKm,
  engineHours: preTripCheck.engineHours,
  location: preTripCheck.location,
  locationAccuracyM: preTripCheck.locationAccuracyM,
}
type CheckRow = Pick<typeof preTripCheck.$inferSelect, keyof typeof checkColumns>

const checkOf = (row: CheckRow): PreTripCheck => ({
  id: row.id,
  recordedAt: row.recordedAt.toISOString(),
  projectId: row.projectId,
  routeId: row.routeId,
  vehicleId: row.vehicleId,
  driverId: row.driverId,
  occurredAt: row.occurredAt.toISOString(),
  items: row.items as CheckedItem[],
  defectCount: row.defectCount,
  odometerKm: row.odometerKm,
  engineHours: row.engineHours,
  // The column is `geometry(Point, 4326)`, flat: what it holds is the contracts' `FlatPoint`.
  location: row.location as FlatPoint | null,
  locationAccuracyM: row.locationAccuracyM,
})

/** A check by its id in the company, as the wire spells it: what the door answers a `pre-trip-check` with, applied or replayed. */
export async function readPreTripCheck(tx: Tx, companyId: string, id: string): Promise<PreTripCheck | undefined> {
  const [row] = await tx
    .select(checkColumns)
    .from(preTripCheck)
    .where(and(eq(preTripCheck.companyId, companyId), eq(preTripCheck.id, id)))
    .limit(1)
  return row === undefined ? undefined : checkOf(row)
}

/** What the door hands the check's effect beside the decision: whose command, on which route, from which device. */
export type CheckContext = {
  companyId: string
  projectId: string
  routeId: string
  routeNumber: number
  driverId: string
  driverName: string
  /** The driver's account: the check's recorder and the ticket's opener. */
  recordedBy: string
  deviceId: string
  now: () => Date
}

/**
 * The effect of an applied `pre-trip-check`: the check appended under the
 * command's id; where it found defects, the office's ticket, one defect row
 * each naming it, and — where one is critical — the vehicle out of service.
 */
export async function appendPreTripCheck(tx: Tx, context: CheckContext, check: PreTripCheckDraft, defects: readonly CheckedItem[], grounds: boolean): Promise<void> {
  const { companyId, projectId } = context
  await tx.insert(preTripCheck).values({
    id: check.id,
    companyId,
    projectId,
    routeId: context.routeId,
    vehicleId: check.vehicleId,
    driverId: context.driverId,
    occurredAt: new Date(check.occurredAt),
    recordedBy: context.recordedBy,
    deviceId: context.deviceId,
    items: check.items,
    defectCount: defects.length,
    odometerKm: check.odometerKm,
    engineHours: check.engineHours,
    location: check.location,
    locationAccuracyM: check.locationAccuracyM,
  })
  if (defects.length === 0) return

  const [facts] = await tx
    .select({ timezone: project.timezone, registration: vehicle.registration, callsign: vehicle.callsign })
    .from(vehicle)
    .innerJoin(project, and(eq(project.companyId, vehicle.companyId), eq(project.id, vehicle.projectId)))
    .where(and(eq(vehicle.companyId, companyId), eq(vehicle.id, check.vehicleId)))
    .limit(1)
  if (facts === undefined) throw new Error(`vehicle ${check.vehicleId} of check ${check.id} is not there`)
  const task = defectTicket({ vehicleLabel: vehicleLabel(facts), driverName: context.driverName, routeLabel: routeLabel(context.routeNumber), checkedAt: whenOn(check.occurredAt, facts.timezone), defects, grounds })
  const opened = await openTicket(tx, {
    companyId,
    draft: {
      projectId,
      kind: task.kind,
      priority: task.priority,
      source: "driver-app",
      subject: task.subject,
      description: task.description,
      occurredAt: new Date(check.occurredAt),
      dueAt: BY_SLA,
      assigneeUserAccountId: null,
      links: { routeId: context.routeId, pickupId: null, containerId: null, propertyId: null, sharedCollectionPointId: null, customerId: null, agreementId: null, driverId: context.driverId, parentTicketId: null },
      alertId: null,
    },
    createdBy: context.recordedBy,
    sourceEventId: null,
    newId,
    now: context.now,
  })
  await tx.insert(vehicleDefect).values(
    defects.map((defect) => ({
      id: newId(),
      companyId,
      projectId,
      vehicleId: check.vehicleId,
      preTripCheckId: check.id,
      label: defect.label,
      critical: defect.critical,
      note: defect.note,
      foundAt: new Date(check.occurredAt),
      status: "open",
      ticketId: opened.row.id,
    })),
  )
  if (grounds) {
    await tx
      .update(vehicle)
      .set({ status: "maintenance" })
      .where(and(eq(vehicle.companyId, companyId), eq(vehicle.id, check.vehicleId), eq(vehicle.status, "active")))
  }
}

// The defects.

const defectColumns = {
  id: vehicleDefect.id,
  projectId: vehicleDefect.projectId,
  vehicleId: vehicleDefect.vehicleId,
  preTripCheckId: vehicleDefect.preTripCheckId,
  label: vehicleDefect.label,
  critical: vehicleDefect.critical,
  note: vehicleDefect.note,
  foundAt: vehicleDefect.foundAt,
  status: vehicleDefect.status,
  ticketId: vehicleDefect.ticketId,
  resolvedAt: vehicleDefect.resolvedAt,
  resolutionNote: vehicleDefect.resolutionNote,
  createdAt: vehicleDefect.createdAt,
  updatedAt: vehicleDefect.updatedAt,
}
type DefectRow = Pick<typeof vehicleDefect.$inferSelect, keyof typeof defectColumns>

const defectOf = (row: DefectRow): VehicleDefect => ({
  id: row.id,
  ...stampsOf(row),
  projectId: row.projectId,
  vehicleId: row.vehicleId,
  preTripCheckId: row.preTripCheckId,
  label: row.label,
  critical: row.critical,
  note: row.note,
  foundAt: row.foundAt.toISOString(),
  status: row.status as VehicleDefectStatus,
  ticketId: row.ticketId,
  resolvedAt: instantOf(row.resolvedAt),
  resolutionNote: row.resolutionNote,
})

const checkScope = (principal: Principal) => and(eq(preTripCheck.companyId, principal.companyId), inProjects(preTripCheck.projectId, principal))
const defectScope = (principal: Principal) => and(eq(vehicleDefect.companyId, principal.companyId), inProjects(vehicleDefect.projectId, principal))

const page = { 400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a filter is malformed, or `projectId` is not a project this account works in."), 401: describeProblem("No usable token (see WWW-Authenticate).") }
const forbidden = (action: string) => ({ 403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${VEHICLES}\`.`) })

export function preTripRoutes(guard: MiddlewareHandler<AuthEnv>, { now }: { now: () => Date }) {
  return new Hono<AuthEnv>()
    .get(
      "/pre-trip-checks",
      describeRoute({
        operationId: "listPreTripChecks",
        summary: "The pre-trip checks of the caller's vehicles",
        description:
          "One page of the pre-trip checks drivers made (O13 of #290) on the vehicles and trailers of the projects the caller works in, oldest first: each item of the checklist as it was answered — its label and weight copied beside whether it passed and what the driver saw — the count of defects found, and the odometer and the engine hours where the driver read them. `projectId`, `vehicleId` and `routeId` narrow it. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: { 200: describeJson("One page of checks.", PreTripCheckPage), ...page, ...forbidden("view") },
      }),
      guard,
      requireGrant(VEHICLES, "view"),
      validate("query", PreTripCheckListQuery),
      async (c) => {
        const { limit, cursor, projectId, vehicleId, routeId } = c.req.valid("query")
        const after = afterCursor(cursor)
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await c
          .get("tx")
          .select(checkColumns)
          .from(preTripCheck)
          .where(
            and(
              checkScope(principal),
              projectId === undefined ? undefined : eq(preTripCheck.projectId, projectId),
              vehicleId === undefined ? undefined : eq(preTripCheck.vehicleId, vehicleId),
              routeId === undefined ? undefined : eq(preTripCheck.routeId, routeId),
              after === undefined ? undefined : gt(preTripCheck.id, after),
            ),
          )
          .orderBy(asc(preTripCheck.id))
          .limit(fetchLimit(limit))
        const { items, nextCursor } = pageOf(rows, limit)
        return c.json({ items: items.map(checkOf), nextCursor })
      },
    )
    .get(
      "/vehicle-defects",
      describeRoute({
        operationId: "listVehicleDefects",
        summary: "The defects pre-trip checks found on the caller's vehicles",
        description:
          "One page of Vehicle Defects (O13 of #290) — each a checklist item a driver's pre-trip check failed, with what the driver saw, whether it was critical, the ticket the check opened and whether the office has resolved it — of the vehicles and trailers of the projects the caller works in, oldest first. `projectId`, `vehicleId` and `status` (`open`, `resolved`) narrow it. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: { 200: describeJson("One page of defects.", VehicleDefectPage), ...page, ...forbidden("view") },
      }),
      guard,
      requireGrant(VEHICLES, "view"),
      validate("query", VehicleDefectListQuery),
      async (c) => {
        const { limit, cursor, projectId, vehicleId, status } = c.req.valid("query")
        const after = afterCursor(cursor)
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await c
          .get("tx")
          .select(defectColumns)
          .from(vehicleDefect)
          .where(
            and(
              defectScope(principal),
              projectId === undefined ? undefined : eq(vehicleDefect.projectId, projectId),
              vehicleId === undefined ? undefined : eq(vehicleDefect.vehicleId, vehicleId),
              status === undefined ? undefined : eq(vehicleDefect.status, status),
              after === undefined ? undefined : gt(vehicleDefect.id, after),
            ),
          )
          .orderBy(asc(vehicleDefect.id))
          .limit(fetchLimit(limit))
        const { items, nextCursor } = pageOf(rows, limit)
        return c.json({ items: items.map(defectOf), nextCursor })
      },
    )
    .post(
      "/vehicle-defects/:id/resolve",
      describeRoute({
        operationId: "resolveVehicleDefect",
        summary: "Mark a vehicle defect resolved",
        description:
          "Marks a Vehicle Defect resolved (O13 of #290): the office says it is mended, with what was done in `note` where it says. The vehicle's status is left as it is — a vehicle a critical defect took out of service is set active again by the vehicle's own edit, once every defect it needs mended is — and the defect's ticket is the ticket's own to close.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The defect, resolved.", VehicleDefect),
          400: describeProblem("The path does not hold an id, or the body names a member it does not own or a note that is blank or too long."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          ...forbidden("edit"),
          404: describeProblem("No vehicle defect with that id in the projects this account works in."),
          409: describeProblem("The defect is already resolved."),
        },
      }),
      guard,
      requireGrant(VEHICLES, "edit"),
      validate("param", IdParam),
      validate("json", VehicleDefectResolve),
      async (c) => {
        const { id } = c.req.valid("param")
        const { note } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        await lockRow(tx, vehicleDefect, { companyId: principal.companyId, id })
        const [found] = await tx.select(defectColumns).from(vehicleDefect).where(and(defectScope(principal), eq(vehicleDefect.id, id))).limit(1)
        if (found === undefined) throw noSuchDefect(id)
        if (found.status === "resolved") throw problem(409, { detail: alreadyResolved(found.label) })
        const [row] = await tx
          .update(vehicleDefect)
          .set({ status: "resolved", resolvedAt: now(), resolvedBy: principal.user.id, resolutionNote: note ?? null, ...stamp() })
          .where(and(eq(vehicleDefect.companyId, principal.companyId), eq(vehicleDefect.id, id)))
          .returning(defectColumns)
        return c.json(defectOf(row))
      },
    )
}
