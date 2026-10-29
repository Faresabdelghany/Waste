// Vehicle maintenance (O20 of #290): a vehicle's maintenance plans and the
// Maintenance Orders that do them, under `fleet.vehicles`.
//
// A plan is answered with where it stands (`due`): its next limits, counted
// from the last service, against the vehicle's latest readings — the
// odometer and the engine hours a driver's pre-trip check last read (O13 of
// #290) — on its project's day (@waste/domain/resources/maintenance). The
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
  type MaintenanceOrderStatus,
  type MaintenancePlanStatus,
} from "@waste/contracts/maintenance"
import type { Tx } from "@waste/db/client"
import { dayInTimezone } from "@waste/db/commands/days"
import { vehicle } from "@waste/db/schema/fleet"
import { maintenanceOrder, vehicleMaintenancePlan } from "@waste/db/schema/maintenance"
import { project } from "@waste/db/schema/organisation"
import { preTripCheck } from "@waste/db/schema/pre-trip"
import { maintenanceDue, planIssue, type VehicleReadings } from "@waste/domain/resources/maintenance"
import { and, asc, desc, eq, gt, inArray, isNotNull } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { vehicleLabel } from "./fleet-lookups"
import { created, describeCreated, describeJson, IdParam, instantOf, lockRow, stamp, stampsOf } from "./shared"

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

const noSuchPlan = (id: string) => problem(404, { detail: `No maintenance plan ${id} in the projects this account works in` })
const noSuchOrder = (id: string) => problem(404, { detail: `No maintenance order ${id} in the projects this account works in` })

const page = { 400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a filter is malformed, or `projectId` is not a project this account works in."), 401: describeProblem("No usable token (see WWW-Authenticate).") }
const unauthenticated = { 401: describeProblem("No usable token (see WWW-Authenticate).") }
const forbidden = (action: string) => ({ 403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${VEHICLES}\`.`) })

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

const planScope = (principal: Principal) => and(eq(vehicleMaintenancePlan.companyId, principal.companyId), inProjects(vehicleMaintenancePlan.projectId, principal))

/** The vehicles' latest readings: the newest odometer and the newest engine hours a pre-trip check read of each, in two statements. */
export async function latestReadings(tx: Tx, companyId: string, vehicleIds: readonly string[]): Promise<Map<string, VehicleReadings>> {
  const readings = new Map<string, VehicleReadings>(vehicleIds.map((id) => [id, { odometerKm: null, engineHours: null }]))
  if (vehicleIds.length === 0) return readings
  const ids = [...new Set(vehicleIds)]
  const [odometers, hours] = await Promise.all([
    tx
      .selectDistinctOn([preTripCheck.vehicleId], { vehicleId: preTripCheck.vehicleId, value: preTripCheck.odometerKm })
      .from(preTripCheck)
      .where(and(eq(preTripCheck.companyId, companyId), inArray(preTripCheck.vehicleId, ids), isNotNull(preTripCheck.odometerKm)))
      .orderBy(asc(preTripCheck.vehicleId), desc(preTripCheck.occurredAt)),
    tx
      .selectDistinctOn([preTripCheck.vehicleId], { vehicleId: preTripCheck.vehicleId, value: preTripCheck.engineHours })
      .from(preTripCheck)
      .where(and(eq(preTripCheck.companyId, companyId), inArray(preTripCheck.vehicleId, ids), isNotNull(preTripCheck.engineHours)))
      .orderBy(asc(preTripCheck.vehicleId), desc(preTripCheck.occurredAt)),
  ])
  for (const row of odometers) readings.set(row.vehicleId, { ...readings.get(row.vehicleId)!, odometerKm: row.value })
  for (const row of hours) readings.set(row.vehicleId, { ...readings.get(row.vehicleId)!, engineHours: row.value })
  return readings
}

/** Today on each of the projects' clocks, by project id. */
async function todaysOf(tx: Tx, companyId: string, projectIds: readonly string[], now: Date): Promise<Map<string, string>> {
  if (projectIds.length === 0) return new Map()
  const rows = await tx
    .select({ id: project.id, timezone: project.timezone })
    .from(project)
    .where(and(eq(project.companyId, companyId), inArray(project.id, [...new Set(projectIds)])))
  return new Map(rows.map((row) => [row.id, dayInTimezone(now, row.timezone)]))
}

/** The plans on the wire, each with where it stands on its project's day against its vehicle's latest readings. */
async function plansOf(tx: Tx, companyId: string, rows: readonly PlanRow[], now: Date): Promise<MaintenancePlan[]> {
  const [readings, todays] = await Promise.all([
    latestReadings(
      tx,
      companyId,
      rows.map((row) => row.vehicleId),
    ),
    todaysOf(
      tx,
      companyId,
      rows.map((row) => row.projectId),
      now,
    ),
  ])
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
    status: row.status as MaintenancePlanStatus,
    due: maintenanceDue(row, todays.get(row.projectId)!, readings.get(row.vehicleId) ?? { odometerKm: null, engineHours: null }),
  }))
}

async function findPlan(tx: Tx, principal: Principal, id: string): Promise<PlanRow | undefined> {
  const [row] = await tx.select(planColumns).from(vehicleMaintenancePlan).where(and(planScope(principal), eq(vehicleMaintenancePlan.id, id))).limit(1)
  return row
}

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
  status: row.status as MaintenanceOrderStatus,
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

export function maintenanceRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date() }: { now?: () => Date } = {}) {
  return new Hono<AuthEnv>()
    .get(
      "/maintenance-plans",
      describeRoute({
        operationId: "listMaintenancePlans",
        summary: "The maintenance plans of the caller's vehicles",
        description:
          "One page of maintenance plans (O20 of #290) of the vehicles and trailers of the projects the caller works in, oldest first, each with `due`: its next limits counted from the last service, the readings it was judged on — the newest a driver's pre-trip check read, else the last service's — and its state on its project's day, `ok`, `due-soon` inside two weeks, a thousand kilometres or fifty hours of a limit, or `overdue` past one. `projectId`, `vehicleId` and `status` narrow it. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: { 200: describeJson("One page of plans.", PlanPage), ...page, ...forbidden("view") },
      }),
      guard,
      requireGrant(VEHICLES, "view"),
      validate("query", MaintenancePlanListQuery),
      async (c) => {
        const { limit, cursor, projectId, vehicleId, status } = c.req.valid("query")
        const after = afterCursor(cursor)
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const tx = c.get("tx")
        const rows = await tx
          .select(planColumns)
          .from(vehicleMaintenancePlan)
          .where(
            and(
              planScope(principal),
              projectId === undefined ? undefined : eq(vehicleMaintenancePlan.projectId, projectId),
              vehicleId === undefined ? undefined : eq(vehicleMaintenancePlan.vehicleId, vehicleId),
              status === undefined ? undefined : eq(vehicleMaintenancePlan.status, status),
              after === undefined ? undefined : gt(vehicleMaintenancePlan.id, after),
            ),
          )
          .orderBy(asc(vehicleMaintenancePlan.id))
          .limit(fetchLimit(limit))
        const { items, nextCursor } = pageOf(rows, limit)
        return c.json({ items: await plansOf(tx, principal.companyId, items, now()), nextCursor })
      },
    )
    .post(
      "/maintenance-plans",
      describeRoute({
        operationId: "createMaintenancePlan",
        summary: "Give a vehicle a maintenance plan",
        description:
          "Gives a vehicle or a trailer of a project the caller works in a service at intervals (O20 of #290): every `intervalDays`, `intervalKm` or `intervalHours`, at least one, counted from the last service — `lastDoneOn`, and the odometer and the engine hours then, which a distance or an hours interval needs. The plan lives in the vehicle's project and starts active. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The plan, with where it stands.", MaintenancePlan),
          400: describeProblem("The body is missing a field, names a member the server owns, gives no interval, a distance or hours interval without its reading, an interval out of bounds, or a vehicle of no project this account works in."),
          ...unauthenticated,
          ...forbidden("create"),
        },
      }),
      guard,
      requireGrant(VEHICLES, "create"),
      validate("json", MaintenancePlanCreate),
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
      describeRoute({
        operationId: "getMaintenancePlan",
        summary: "One maintenance plan",
        description: "One maintenance plan of the caller's projects, with where it stands (O20 of #290).",
        security: BEARER_SECURITY,
        responses: { 200: describeJson("The plan.", MaintenancePlan), 400: describeProblem("The path does not hold an id."), ...unauthenticated, ...forbidden("view"), 404: describeProblem("No maintenance plan with that id in the projects this account works in.") },
      }),
      guard,
      requireGrant(VEHICLES, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findPlan(tx, principal, id)
        if (row === undefined) throw noSuchPlan(id)
        const [plan] = await plansOf(tx, principal.companyId, [row], now())
        return c.json(plan)
      },
    )
    .patch(
      "/maintenance-plans/:id",
      describeRoute({
        operationId: "patchMaintenancePlan",
        summary: "Change a maintenance plan",
        description:
          "Changes a plan's name, its intervals (null for none), its last service, or its status — `retired` raises nothing more and keeps the orders that name it (O20 of #290). The plan as it then stands must still give an interval, and the reading each distance or hours interval counts from (400 at the field). A Maintenance Order completed moves the last service by itself.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The plan, with where it stands.", MaintenancePlan),
          400: describeProblem("The path does not hold an id, or the body changes nothing, names a member the server owns, or leaves the plan without an interval or an interval without its reading."),
          ...unauthenticated,
          ...forbidden("edit"),
          404: describeProblem("No maintenance plan with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(VEHICLES, "edit"),
      validate("param", IdParam),
      validate("json", MaintenancePlanPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        await lockRow(tx, vehicleMaintenancePlan, { companyId: principal.companyId, id })
        const found = await findPlan(tx, principal, id)
        if (found === undefined) throw noSuchPlan(id)
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
      describeRoute({
        operationId: "listMaintenanceOrders",
        summary: "The maintenance orders of the caller's vehicles",
        description: "One page of Maintenance Orders (O20 of #290) of the vehicles and trailers of the projects the caller works in, oldest first. `projectId`, `vehicleId`, `planId` and `status` (`open`, `completed`, `cancelled`) narrow it. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: { 200: describeJson("One page of orders.", OrderPage), ...page, ...forbidden("view") },
      }),
      guard,
      requireGrant(VEHICLES, "view"),
      validate("query", MaintenanceOrderListQuery),
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
      describeRoute({
        operationId: "createMaintenanceOrder",
        summary: "Open a maintenance order",
        description:
          "Opens a Maintenance Order on a vehicle or a trailer of a project the caller works in (O20 of #290): of one of the vehicle's active plans, whose name it takes where `title` is absent, or a one-off with its own title — a repair, a defect mended. `dueOn` is the day it is planned for. The order lives in the vehicle's project and starts open. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The order, open.", MaintenanceOrder),
          400: describeProblem("The body is missing a field, names a member the server owns, names neither a plan nor a title, a vehicle of no project this account works in, or a plan that is not an active plan of the vehicle."),
          ...unauthenticated,
          ...forbidden("create"),
        },
      }),
      guard,
      requireGrant(VEHICLES, "create"),
      validate("json", MaintenanceOrderCreate),
      async (c) => {
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const what = await vehicleHere(tx, principal, body.vehicleId)
        let title = body.title
        if (body.planId !== undefined) {
          const plan = await findPlan(tx, principal, body.planId)
          if (plan === undefined || plan.vehicleId !== what.id || plan.status !== "active") throw invalidRequest("json", [{ path: "planId", message: NOT_A_PLAN_OF_THE_VEHICLE }])
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
      describeRoute({
        operationId: "getMaintenanceOrder",
        summary: "One maintenance order",
        description: "One Maintenance Order of the caller's projects (O20 of #290).",
        security: BEARER_SECURITY,
        responses: { 200: describeJson("The order.", MaintenanceOrder), 400: describeProblem("The path does not hold an id."), ...unauthenticated, ...forbidden("view"), 404: describeProblem("No maintenance order with that id in the projects this account works in.") },
      }),
      guard,
      requireGrant(VEHICLES, "view"),
      validate("param", IdParam),
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
      describeRoute({
        operationId: "completeMaintenanceOrder",
        summary: "Complete a maintenance order",
        description:
          "Closes an open order as done (O20 of #290): on `completedOn`, no later than the project's today, with the odometer and the engine hours then and what was done. An order of a plan is the plan's service: the plan's last service moves to the completion's day and readings, and a plan that counts kilometres or engine hours needs its reading.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The order, completed.", MaintenanceOrder),
          400: describeProblem("The path does not hold an id, or the body is missing `completedOn`, names a member it does not own, gives a day after the project's today, or leaves out the reading its plan counts."),
          ...unauthenticated,
          ...forbidden("edit"),
          404: describeProblem("No maintenance order with that id in the projects this account works in."),
          409: describeProblem("The order is already completed or cancelled."),
        },
      }),
      guard,
      requireGrant(VEHICLES, "edit"),
      validate("param", IdParam),
      validate("json", MaintenanceOrderComplete),
      async (c) => {
        const { id } = c.req.valid("param")
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const order = await openOrder(tx, principal, id)
        const today = (await todaysOf(tx, principal.companyId, [order.projectId], now())).get(order.projectId)!
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
      describeRoute({
        operationId: "cancelMaintenanceOrder",
        summary: "Cancel a maintenance order",
        description: "Closes an open order as not done, with why in `note` where the office says (O20 of #290). Its plan's last service stays as it was.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The order, cancelled.", MaintenanceOrder),
          400: describeProblem("The path does not hold an id, or the body names a member it does not own or a blank note."),
          ...unauthenticated,
          ...forbidden("edit"),
          404: describeProblem("No maintenance order with that id in the projects this account works in."),
          409: describeProblem("The order is already completed or cancelled."),
        },
      }),
      guard,
      requireGrant(VEHICLES, "edit"),
      validate("param", IdParam),
      validate("json", MaintenanceOrderCancel),
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
