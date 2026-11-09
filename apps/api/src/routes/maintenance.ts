// Vehicle maintenance (O20 of #290): a vehicle's maintenance plans and the
// Maintenance Orders that do them, under `fleet.vehicles`.
//
// A plan is answered with where it stands (`due`): its next limits, counted
// from the last service, against the last service's own readings, since
// nothing reads a vehicle's odometer or engine hours between services, on
// its project's day (@waste/domain/resources/maintenance). The
// rule a plan is held to, an interval and the reading each distance or hours
// interval counts from, is the contracts' on a create and the domain's over
// the merged row on a patch. A plan is retired, never deleted.
//
// An order is opened on a vehicle, of one of its active plans or a one-off
// with its own title, and closed once: completed on a day no later than the
// project's today, with the readings then, or cancelled. Completing a plan's
// order is the service done, so the plan's baseline moves to the completion's
// day and readings in the same request; a distance or hours plan needs its
// reading, since the next limit counts from it. The worker's `maintenance-due`
// rule then clears the plan's alert on its next tick.
import { Page } from "@waste/contracts/pagination"
import {
  MaintenanceOrder,
  MaintenanceOrderCancel,
  MaintenanceOrderComplete,
  MaintenanceOrderCreate,
  MaintenanceOrderListQuery,
  MaintenancePlan,
  MaintenancePlanCreate,
  MaintenancePlanListQuery,
  MaintenancePlanPatch,
} from "@waste/contracts/maintenance"
import type { Tx } from "@waste/db/client"
import { vehicle } from "@waste/db/schema/fleet"
import { maintenanceOrder, vehicleMaintenancePlan } from "@waste/db/schema/maintenance"
import { projectTodays } from "@waste/db/query/project-clock"
import { maintenanceDue, planIssue, type VehicleReadings } from "@waste/domain/resources/maintenance"
import { ACTIVE_MAINTENANCE_PLAN_STATUSES } from "@waste/domain/resources/vocabulary"
import { takesReference } from "@waste/domain/status-gates"
import { and, asc, eq, gt } from "drizzle-orm"
import { newId } from "@waste/db/ids"
import { instantOf, stampsOf } from "@waste/db/shapes/times"
import { lockRow } from "@waste/db/commands/shared"
import { vehicleLabel } from "@waste/db/commands/fleet-fit"

import type { Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import type { RouteDeps } from "../deps"
import { routes } from "../operation"
import { afterCursor, fetchLimit, pageAt, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem } from "../problem"
import { scoped } from "../scoped"
import { created, describeCreated, describeJson, IdParam, stamp } from "./shared"

const VEHICLES = "fleet.vehicles"
const PlanPage = Page(MaintenancePlan)
const OrderPage = Page(MaintenanceOrder)

/** What a body naming a vehicle of no project the caller works in is told. */
export const NOT_A_VEHICLE_HERE = "Not a vehicle of a project this account works in"
/** What an order naming a plan of another vehicle, or a retired one, is told. */
export const NOT_A_PLAN_OF_THE_VEHICLE = "Not an active maintenance plan of this vehicle"
/** What a completion after the project's today is told. */
export const NOT_AHEAD = "A service is completed on a day that has come, not ahead of it"
/** What a closed order is told by a second close. */
export const alreadyClosed = (title: string, status: string): string => `The order ${title} is already ${status}`
/** What a plan's service is told without the reading its next limit counts from. */
export const NEEDS_THE_ODOMETER = "The plan counts kilometres: give the odometer at the service"
export const NEEDS_THE_HOURS = "The plan counts engine hours: give them at the service"

const noSuchOrder = (id: string) => problem(404, { detail: `No maintenance order ${id} in the projects this account works in` })

/** What a list refuses beside the page rule. */
const LIST_INVALID = ["a filter is malformed", "`projectId` is not a project this account works in"]

// The plans.

const planColumns = {
  id: vehicleMaintenancePlan.id,
  projectId: vehicleMaintenancePlan.projectId,
  vehicleId: vehicleMaintenancePlan.vehicleId,
  name: vehicleMaintenancePlan.name,
  intervalDays: vehicleMaintenancePlan.intervalDays,
  intervalKm: vehicleMaintenancePlan.intervalKm,
  intervalHours: vehicleMaintenancePlan.intervalHours,
  lastDoneOn: vehicleMaintenancePlan.lastDoneOn,
  lastDoneKm: vehicleMaintenancePlan.lastDoneKm,
  lastDoneHours: vehicleMaintenancePlan.lastDoneHours,
  status: vehicleMaintenancePlan.status,
  createdAt: vehicleMaintenancePlan.createdAt,
  updatedAt: vehicleMaintenancePlan.updatedAt,
}
type PlanRow = Pick<typeof vehicleMaintenancePlan.$inferSelect, keyof typeof planColumns>

/** The readings a plan is judged on between services: none, since nothing reads a vehicle's odometer or engine hours, so the last service's own stand. */
const NO_READINGS: VehicleReadings = { odometerKm: null, engineHours: null }

/** The plans on the wire, each with where it stands on its project's day against its last service's readings. */
async function plansOf(tx: Tx, companyId: string, rows: readonly PlanRow[], now: Date): Promise<MaintenancePlan[]> {
  const todays = await projectTodays(
    tx,
    companyId,
    rows.map((row) => row.projectId),
    now,
  )
  return rows.map((row) => ({
    id: row.id,
    ...stampsOf(row),
    projectId: row.projectId,
    vehicleId: row.vehicleId,
    name: row.name,
    intervalDays: row.intervalDays,
    intervalKm: row.intervalKm,
    intervalHours: row.intervalHours,
    lastDoneOn: row.lastDoneOn,
    lastDoneKm: row.lastDoneKm,
    lastDoneHours: row.lastDoneHours,
    status: row.status,
    due: maintenanceDue(row, todays.get(row.projectId)!, NO_READINGS),
  }))
}

const { find: findPlan, get: getPlan, locked: lockedPlan, list: listPlans } = scoped(vehicleMaintenancePlan, { noun: "maintenance plan", reach: "projects", columns: planColumns })

/** The vehicle a body names, of a project the caller works in, or the 400 at `vehicleId`. */
async function vehicleHere(tx: Tx, principal: Principal, id: string): Promise<{ id: string; projectId: string; label: string }> {
  const [row] = await tx
    .select({ id: vehicle.id, projectId: vehicle.projectId, registration: vehicle.registration, callsign: vehicle.callsign })
    .from(vehicle)
    .where(and(eq(vehicle.companyId, principal.companyId), inProjects(vehicle.projectId, principal), eq(vehicle.id, id)))
    .limit(1)
  if (row === undefined) throw invalidRequest("json", [{ path: "vehicleId", message: NOT_A_VEHICLE_HERE }])
  return { id: row.id, projectId: row.projectId, label: vehicleLabel(row) }
}

// The orders.

const orderColumns = {
  id: maintenanceOrder.id,
  projectId: maintenanceOrder.projectId,
  vehicleId: maintenanceOrder.vehicleId,
  planId: maintenanceOrder.planId,
  title: maintenanceOrder.title,
  status: maintenanceOrder.status,
  dueOn: maintenanceOrder.dueOn,
  note: maintenanceOrder.note,
  completedOn: maintenanceOrder.completedOn,
  odometerKm: maintenanceOrder.odometerKm,
  engineHours: maintenanceOrder.engineHours,
  closingNote: maintenanceOrder.closingNote,
  closedAt: maintenanceOrder.closedAt,
  createdAt: maintenanceOrder.createdAt,
  updatedAt: maintenanceOrder.updatedAt,
}
type OrderRow = Pick<typeof maintenanceOrder.$inferSelect, keyof typeof orderColumns>

const orderOf = (row: OrderRow): MaintenanceOrder => ({
  id: row.id,
  ...stampsOf(row),
  projectId: row.projectId,
  vehicleId: row.vehicleId,
  planId: row.planId,
  title: row.title,
  status: row.status,
  dueOn: row.dueOn,
  note: row.note,
  completedOn: row.completedOn,
  odometerKm: row.odometerKm,
  engineHours: row.engineHours,
  closingNote: row.closingNote,
  closedAt: instantOf(row.closedAt),
})

const orderScope = (principal: Principal) => and(eq(maintenanceOrder.companyId, principal.companyId), inProjects(maintenanceOrder.projectId, principal))

/** An open order of the caller's projects, locked, or the 404, or the 409 of one already closed. */
async function openOrder(tx: Tx, principal: Principal, id: string): Promise<OrderRow> {
  await lockRow(tx, maintenanceOrder, { companyId: principal.companyId, id })
  const [row] = await tx.select(orderColumns).from(maintenanceOrder).where(and(orderScope(principal), eq(maintenanceOrder.id, id))).limit(1)
  if (row === undefined) throw noSuchOrder(id)
  if (row.status !== "open") throw problem(409, { detail: alreadyClosed(row.title, row.status) })
  return row
}

export function maintenanceRoutes(deps: RouteDeps) {
  const { now } = deps
  return routes(deps)
    .get(
      "/maintenance-plans",
      {
        operationId: "listMaintenancePlans",
        summary: "The maintenance plans of the caller's vehicles",
        description:
          "One page of maintenance plans (O20 of #290) of the vehicles and trailers of the projects the caller works in, oldest first, each with `due`: its next limits counted from the last service, the readings it was judged on — the last service's — and its state on its project's day, `ok`, `due-soon` inside two weeks, a thousand kilometres or fifty hours of a limit, or `overdue` past one. `projectId`, `vehicleId` and `status` narrow it. Hand `nextCursor` back as `cursor` for the next page.",
        module: VEHICLES,
        action: "view",
        query: MaintenancePlanListQuery,
        invalid: LIST_INVALID,
        responses: { 200: describeJson("One page of plans.", PlanPage) },
      },
      async (c) => {
        const { limit, cursor, projectId, vehicleId, status } = c.req.valid("query")
        const at = pageAt({ cursor, limit })
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const tx = c.get("tx")
        const { items, nextCursor } = await listPlans(tx, principal, at, projectId === undefined ? undefined : eq(vehicleMaintenancePlan.projectId, projectId), vehicleId === undefined ? undefined : eq(vehicleMaintenancePlan.vehicleId, vehicleId), status === undefined ? undefined : eq(vehicleMaintenancePlan.status, status))
        return c.json({ items: await plansOf(tx, principal.companyId, items, now()), nextCursor })
      },
    )
    .post(
      "/maintenance-plans",
      {
        operationId: "createMaintenancePlan",
        summary: "Give a vehicle a maintenance plan",
        description:
          "Gives a vehicle or a trailer of a project the caller works in a service at intervals (O20 of #290): every `intervalDays`, `intervalKm` or `intervalHours`, at least one, counted from the last service — `lastDoneOn`, and the odometer and the engine hours then, which a distance or an hours interval needs. The plan lives in the vehicle's project and starts active. The server mints the id.",
        module: VEHICLES,
        action: "create",
        body: MaintenancePlanCreate,
        invalid: ["the body is missing a field, names a member the server owns, gives no interval, a distance or hours interval without its reading, an interval out of bounds, or a vehicle of no project this account works in"],
        responses: {
          201: describeCreated("The plan, with where it stands.", MaintenancePlan),
        },
      },
      async (c) => {
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const what = await vehicleHere(tx, principal, body.vehicleId)
        const [row] = await tx
          .insert(vehicleMaintenancePlan)
          .values({
            id: newId(),
            companyId: principal.companyId,
            projectId: what.projectId,
            vehicleId: what.id,
            name: body.name,
            intervalDays: body.intervalDays ?? null,
            intervalKm: body.intervalKm ?? null,
            intervalHours: body.intervalHours ?? null,
            lastDoneOn: body.lastDoneOn,
            lastDoneKm: body.lastDoneKm ?? null,
            lastDoneHours: body.lastDoneHours ?? null,
            status: "active",
          })
          .returning(planColumns)
        const [plan] = await plansOf(tx, principal.companyId, [row], now())
        return created(c, "/maintenance-plans", plan)
      },
    )
    .get(
      "/maintenance-plans/:id",
      {
        operationId: "getMaintenancePlan",
        summary: "One maintenance plan",
        description: "One maintenance plan of the caller's projects, with where it stands (O20 of #290).",
        module: VEHICLES,
        action: "view",
        params: IdParam,
        responses: { 200: describeJson("The plan.", MaintenancePlan), 404: describeProblem("No maintenance plan with that id in the projects this account works in.") },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await getPlan(tx, principal, id)
        const [plan] = await plansOf(tx, principal.companyId, [row], now())
        return c.json(plan)
      },
    )
    .patch(
      "/maintenance-plans/:id",
      {
        operationId: "patchMaintenancePlan",
        summary: "Change a maintenance plan",
        description:
          "Changes a plan's name, its intervals (null for none), its last service, or its status — `retired` raises nothing more and keeps the orders that name it (O20 of #290). The plan as it then stands must still give an interval, and the reading each distance or hours interval counts from (400 at the field). A Maintenance Order completed moves the last service by itself.",
        module: VEHICLES,
        action: "edit",
        params: IdParam,
        body: MaintenancePlanPatch,
        invalid: ["the body changes nothing, names a member the server owns, or leaves the plan without an interval or an interval without its reading"],
        responses: {
          200: describeJson("The plan, with where it stands.", MaintenancePlan),
          404: describeProblem("No maintenance plan with that id in the projects this account works in."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const found = await lockedPlan(tx, principal, id)
        const merged = { ...found, ...patch }
        const issue = planIssue(merged)
        if (issue !== undefined) throw invalidRequest("json", [issue])
        const [row] = await tx
          .update(vehicleMaintenancePlan)
          .set({ ...patch, ...stamp() })
          .where(and(eq(vehicleMaintenancePlan.companyId, principal.companyId), eq(vehicleMaintenancePlan.id, id)))
          .returning(planColumns)
        const [plan] = await plansOf(tx, principal.companyId, [row], now())
        return c.json(plan)
      },
    )
    .get(
      "/maintenance-orders",
      {
        operationId: "listMaintenanceOrders",
        summary: "The maintenance orders of the caller's vehicles",
        description: "One page of Maintenance Orders (O20 of #290) of the vehicles and trailers of the projects the caller works in, oldest first. `projectId`, `vehicleId`, `planId` and `status` (`open`, `completed`, `cancelled`) narrow it. Hand `nextCursor` back as `cursor` for the next page.",
        module: VEHICLES,
        action: "view",
        query: MaintenanceOrderListQuery,
        invalid: LIST_INVALID,
        responses: { 200: describeJson("One page of orders.", OrderPage) },
      },
      async (c) => {
        const { limit, cursor, projectId, vehicleId, planId, status } = c.req.valid("query")
        const after = afterCursor(cursor)
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await c
          .get("tx")
          .select(orderColumns)
          .from(maintenanceOrder)
          .where(
            and(
              orderScope(principal),
              projectId === undefined ? undefined : eq(maintenanceOrder.projectId, projectId),
              vehicleId === undefined ? undefined : eq(maintenanceOrder.vehicleId, vehicleId),
              planId === undefined ? undefined : eq(maintenanceOrder.planId, planId),
              status === undefined ? undefined : eq(maintenanceOrder.status, status),
              after === undefined ? undefined : gt(maintenanceOrder.id, after),
            ),
          )
          .orderBy(asc(maintenanceOrder.id))
          .limit(fetchLimit(limit))
        const { items, nextCursor } = pageOf(rows, limit)
        return c.json({ items: items.map(orderOf), nextCursor })
      },
    )
    .post(
      "/maintenance-orders",
      {
        operationId: "createMaintenanceOrder",
        summary: "Open a maintenance order",
        description:
          "Opens a Maintenance Order on a vehicle or a trailer of a project the caller works in (O20 of #290): of one of the vehicle's active plans, whose name it takes where `title` is absent, or a one-off with its own title — a repair, a defect mended. `dueOn` is the day it is planned for. The order lives in the vehicle's project and starts open. The server mints the id.",
        module: VEHICLES,
        action: "create",
        body: MaintenanceOrderCreate,
        invalid: ["the body is missing a field, names a member the server owns, names neither a plan nor a title, a vehicle of no project this account works in, or a plan that is not an active plan of the vehicle"],
        responses: {
          201: describeCreated("The order, open.", MaintenanceOrder),
        },
      },
      async (c) => {
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const what = await vehicleHere(tx, principal, body.vehicleId)
        let title = body.title
        if (body.planId !== undefined) {
          const plan = await findPlan(tx, principal, body.planId)
          if (plan === undefined || plan.vehicleId !== what.id || !takesReference(plan.status, ACTIVE_MAINTENANCE_PLAN_STATUSES)) throw invalidRequest("json", [{ path: "planId", message: NOT_A_PLAN_OF_THE_VEHICLE }])
          title ??= plan.name
        }
        const [row] = await tx
          .insert(maintenanceOrder)
          .values({ id: newId(), companyId: principal.companyId, projectId: what.projectId, vehicleId: what.id, planId: body.planId ?? null, title: title!, status: "open", dueOn: body.dueOn ?? null, note: body.note ?? null })
          .returning(orderColumns)
        return created(c, "/maintenance-orders", orderOf(row))
      },
    )
    .get(
      "/maintenance-orders/:id",
      {
        operationId: "getMaintenanceOrder",
        summary: "One maintenance order",
        description: "One Maintenance Order of the caller's projects (O20 of #290).",
        module: VEHICLES,
        action: "view",
        params: IdParam,
        responses: { 200: describeJson("The order.", MaintenanceOrder), 404: describeProblem("No maintenance order with that id in the projects this account works in.") },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const [row] = await c
          .get("tx")
          .select(orderColumns)
          .from(maintenanceOrder)
          .where(and(orderScope(c.get("principal")), eq(maintenanceOrder.id, id)))
          .limit(1)
        if (row === undefined) throw noSuchOrder(id)
        return c.json(orderOf(row))
      },
    )
    .post(
      "/maintenance-orders/:id/complete",
      {
        operationId: "completeMaintenanceOrder",
        summary: "Complete a maintenance order",
        description:
          "Closes an open order as done (O20 of #290): on `completedOn`, no later than the project's today, with the odometer and the engine hours then and what was done. An order of a plan is the plan's service: the plan's last service moves to the completion's day and readings, and a plan that counts kilometres or engine hours needs its reading.",
        module: VEHICLES,
        action: "edit",
        params: IdParam,
        body: MaintenanceOrderComplete,
        invalid: ["the body is missing `completedOn`, names a member it does not own, gives a day after the project's today, or leaves out the reading its plan counts"],
        responses: {
          200: describeJson("The order, completed.", MaintenanceOrder),
          404: describeProblem("No maintenance order with that id in the projects this account works in."),
          409: describeProblem("The order is already completed or cancelled."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const order = await openOrder(tx, principal, id)
        const today = (await projectTodays(tx, principal.companyId, [order.projectId], now())).get(order.projectId)!
        if (body.completedOn > today) throw invalidRequest("json", [{ path: "completedOn", message: NOT_AHEAD }])
        if (order.planId !== null) {
          await lockRow(tx, vehicleMaintenancePlan, { companyId: principal.companyId, id: order.planId })
          const plan = await findPlan(tx, principal, order.planId)
          if (plan === undefined) throw new Error(`plan ${order.planId} of order ${order.id} is not there`)
          if (plan.intervalKm !== null && body.odometerKm === undefined) throw invalidRequest("json", [{ path: "odometerKm", message: NEEDS_THE_ODOMETER }])
          if (plan.intervalHours !== null && body.engineHours === undefined) throw invalidRequest("json", [{ path: "engineHours", message: NEEDS_THE_HOURS }])
          await tx
            .update(vehicleMaintenancePlan)
            .set({ lastDoneOn: body.completedOn, lastDoneKm: body.odometerKm ?? plan.lastDoneKm, lastDoneHours: body.engineHours ?? plan.lastDoneHours, ...stamp() })
            .where(and(eq(vehicleMaintenancePlan.companyId, principal.companyId), eq(vehicleMaintenancePlan.id, plan.id)))
        }
        const [row] = await tx
          .update(maintenanceOrder)
          .set({ status: "completed", completedOn: body.completedOn, odometerKm: body.odometerKm ?? null, engineHours: body.engineHours ?? null, closingNote: body.note ?? null, closedAt: now(), closedBy: principal.user.id, ...stamp() })
          .where(and(eq(maintenanceOrder.companyId, principal.companyId), eq(maintenanceOrder.id, id)))
          .returning(orderColumns)
        return c.json(orderOf(row))
      },
    )
    .post(
      "/maintenance-orders/:id/cancel",
      {
        operationId: "cancelMaintenanceOrder",
        summary: "Cancel a maintenance order",
        description: "Closes an open order as not done, with why in `note` where the office says (O20 of #290). Its plan's last service stays as it was.",
        module: VEHICLES,
        action: "edit",
        params: IdParam,
        body: MaintenanceOrderCancel,
        invalid: ["the body names a member it does not own or a blank note"],
        responses: {
          200: describeJson("The order, cancelled.", MaintenanceOrder),
          404: describeProblem("No maintenance order with that id in the projects this account works in."),
          409: describeProblem("The order is already completed or cancelled."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const { note } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        await openOrder(tx, principal, id)
        const [row] = await tx
          .update(maintenanceOrder)
          .set({ status: "cancelled", closingNote: note ?? null, closedAt: now(), closedBy: principal.user.id, ...stamp() })
          .where(and(eq(maintenanceOrder.companyId, principal.companyId), eq(maintenanceOrder.id, id)))
          .returning(orderColumns)
        return c.json(orderOf(row))
      },
    )
}
