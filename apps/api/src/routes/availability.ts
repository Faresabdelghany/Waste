// When a driver or a vehicle is not there (O6 of #290): a driver's absences
// and a vehicle's unavailability, each a period over days (ADR-0005), read,
// recorded, moved and removed. `GET`/`POST /driver-absences`, `GET`/`PATCH`/
// `DELETE /driver-absences/:id`, and the same five over
// `/vehicle-unavailability`, a vehicle there being either kind.
//
// A period is recorded for a driver or a vehicle of a project the caller
// works in (400 at the field otherwise), and lives in that project. One
// period of a driver, or of a vehicle, covers a day: the database's exclusion
// constraint holds it, and the route asks first so the 409 names the period
// already there, the constraint's own sentence answering a race. Recording
// one is never refused for the work already planned on its days — somebody
// falls ill whatever the plan says; the commands that name the driver or the
// vehicle afresh read these rows (routes/availability-rules.ts). A patch
// moves the period, the reason or the note and never whose it is; a period
// entered wrongly is deleted, the only delete this API answers, since nothing
// references a period and the audit trail keeps what it was, under its
// driver's or vehicle's history (sql/audit-trail.ts, ABSENCES_AUDITED).
//
// Every statement carries the tenant and `inProjects`; the grants are the
// fleet's own — `fleet.drivers` for absences, `fleet.vehicles` for
// unavailability — `view` to read, `create`, `edit` and `delete` to write.
import {
  DriverAbsence,
  DriverAbsenceCreate,
  DriverAbsenceListQuery,
  DriverAbsencePatch,
  VehicleUnavailability,
  VehicleUnavailabilityCreate,
  VehicleUnavailabilityListQuery,
  VehicleUnavailabilityPatch,
  type DriverAbsenceReason,
  type VehicleUnavailabilityReason,
} from "@waste/contracts/availability"
import { Page } from "@waste/contracts/pagination"
import type { Tx } from "@waste/db/client"
import { driverAbsence, vehicleUnavailability } from "@waste/db/schema/availability"
import { driver, vehicle } from "@waste/db/schema/fleet"
import { alreadyAbsent, alreadyUnavailable } from "@waste/domain/resources/availability"
import { and, asc, eq, gt, isNull, lte, or, type SQL } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { vehicleLabel } from "./fleet-lookups"
import { awayOver, driverName, vehicleName } from "./availability-rules"
import { periodAfter, periodOf, requireOrdered } from "./periods"
import { created, describeCreated, describeJson, IdParam, lockRow, refuseOverlap, stampsOf } from "./shared"

const DRIVERS = "fleet.drivers"
const VEHICLES = "fleet.vehicles"

/** A driver or a vehicle a body names: one of a project the caller works in. */
export const NOT_A_DRIVER_HERE = "Not a driver of a project this account works in"
export const NOT_A_VEHICLE_HERE = "Not a vehicle of a project this account works in"

/** What the exclusion constraint answers a race with, where the route's own read did not see the period first. */
const DRIVER_AWAY_ALREADY = "This driver is already absent on one of those days; one absence covers a day"
const VEHICLE_AWAY_ALREADY = "This vehicle is already unavailable on one of those days; one period covers a day"

const noSuchAbsence = (id: string) => problem(404, { detail: `No driver absence ${id} in the projects this account works in` })
const noSuchUnavailability = (id: string) => problem(404, { detail: `No vehicle unavailability ${id} in the projects this account works in` })

const DriverAbsencePage = Page(DriverAbsence)
const VehicleUnavailabilityPage = Page(VehicleUnavailability)

/** The periods touching the days `from` through `to`, both in: started by the last and not ended before the first. */
function touching(validFrom: PgColumn, validTo: PgColumn, from: string | undefined, to: string | undefined): SQL | undefined {
  return and(to === undefined ? undefined : lte(validFrom, to), from === undefined ? undefined : or(isNull(validTo), gt(validTo, from)))
}

const page = { 400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a filter is malformed, the window runs backwards, or `projectId` is not a project this account works in."), 401: describeProblem("No usable token (see WWW-Authenticate).") }
const unauthenticated = { 401: describeProblem("No usable token (see WWW-Authenticate).") }
const forbidden = (action: string, module: string) => ({ 403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${module}\`.`) })

// ---------------------------------------------------------------------------
// A driver's absences
// ---------------------------------------------------------------------------

const absenceColumns = {
  id: driverAbsence.id,
  projectId: driverAbsence.projectId,
  driverId: driverAbsence.driverId,
  validFrom: driverAbsence.validFrom,
  validTo: driverAbsence.validTo,
  reason: driverAbsence.reason,
  note: driverAbsence.note,
  createdAt: driverAbsence.createdAt,
  updatedAt: driverAbsence.updatedAt,
}
type AbsenceRow = Pick<typeof driverAbsence.$inferSelect, keyof typeof absenceColumns>

const absenceOf = (row: AbsenceRow): DriverAbsence => ({
  id: row.id,
  projectId: row.projectId,
  driverId: row.driverId,
  validFrom: row.validFrom,
  validTo: row.validTo,
  reason: row.reason as DriverAbsenceReason,
  note: row.note,
  ...stampsOf(row),
})

const absenceScope = (principal: Principal) => and(eq(driverAbsence.companyId, principal.companyId), inProjects(driverAbsence.projectId, principal))

async function findAbsence(tx: Tx, principal: Principal, id: string): Promise<AbsenceRow | undefined> {
  const [row] = await tx.select(absenceColumns).from(driverAbsence).where(and(absenceScope(principal), eq(driverAbsence.id, id))).limit(1)
  return row
}

/** The driver a body names, of a project the caller works in: its name for a sentence and its project for the row. */
async function driverHere(tx: Tx, principal: Principal, id: string): Promise<{ id: string; name: string; projectId: string }> {
  const [row] = await tx
    .select({ id: driver.id, name: driver.name, projectId: driver.projectId })
    .from(driver)
    .where(and(eq(driver.companyId, principal.companyId), inProjects(driver.projectId, principal), eq(driver.id, id)))
    .limit(1)
  if (row === undefined) throw invalidRequest("body", [{ path: "driverId", message: NOT_A_DRIVER_HERE }])
  return row
}

// ---------------------------------------------------------------------------
// A vehicle's unavailability
// ---------------------------------------------------------------------------

const unavailabilityColumns = {
  id: vehicleUnavailability.id,
  projectId: vehicleUnavailability.projectId,
  vehicleId: vehicleUnavailability.vehicleId,
  validFrom: vehicleUnavailability.validFrom,
  validTo: vehicleUnavailability.validTo,
  reason: vehicleUnavailability.reason,
  note: vehicleUnavailability.note,
  createdAt: vehicleUnavailability.createdAt,
  updatedAt: vehicleUnavailability.updatedAt,
}
type UnavailabilityRow = Pick<typeof vehicleUnavailability.$inferSelect, keyof typeof unavailabilityColumns>

const unavailabilityOf = (row: UnavailabilityRow): VehicleUnavailability => ({
  id: row.id,
  projectId: row.projectId,
  vehicleId: row.vehicleId,
  validFrom: row.validFrom,
  validTo: row.validTo,
  reason: row.reason as VehicleUnavailabilityReason,
  note: row.note,
  ...stampsOf(row),
})

const unavailabilityScope = (principal: Principal) => and(eq(vehicleUnavailability.companyId, principal.companyId), inProjects(vehicleUnavailability.projectId, principal))

async function findUnavailability(tx: Tx, principal: Principal, id: string): Promise<UnavailabilityRow | undefined> {
  const [row] = await tx.select(unavailabilityColumns).from(vehicleUnavailability).where(and(unavailabilityScope(principal), eq(vehicleUnavailability.id, id))).limit(1)
  return row
}

/** The vehicle or trailer a body names, of a project the caller works in: its label for a sentence and its project for the row. */
async function vehicleHere(tx: Tx, principal: Principal, id: string): Promise<{ id: string; label: string; projectId: string }> {
  const [row] = await tx
    .select({ id: vehicle.id, registration: vehicle.registration, callsign: vehicle.callsign, projectId: vehicle.projectId })
    .from(vehicle)
    .where(and(eq(vehicle.companyId, principal.companyId), inProjects(vehicle.projectId, principal), eq(vehicle.id, id)))
    .limit(1)
  if (row === undefined) throw invalidRequest("body", [{ path: "vehicleId", message: NOT_A_VEHICLE_HERE }])
  return { id: row.id, label: vehicleLabel(row), projectId: row.projectId }
}

const PERIOD_RULES =
  "The period is half-open over days — `validFrom` the first day away, `validTo` the first day back, absent or null while the return is not known — and ends after it starts (400 at `validTo`). One period of the same driver or vehicle covers a day: another over any of its days is refused (409) naming the one already there."
const NEVER_REFUSED_FOR_WORK =
  " Never refused for the work already planned on its days: the commands that name the driver or the vehicle afresh — an allocation, a collection group's crew, a route's assign, create and reschedule, and a dispatch to its planned driver — refuse there instead."

export function availabilityRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/driver-absences",
      describeRoute({
        operationId: "listDriverAbsences",
        summary: "The absences of the drivers of the caller's projects",
        description:
          "One page of driver absences, oldest first (ids are time-ordered), from the projects the caller works in. `projectId` narrows it to one of those projects, `driverId` to one driver, and `from` and `to` (both inclusive, `to` on or after `from`) to the absences touching that window of days. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: { 200: describeJson("One page of absences.", DriverAbsencePage), ...page, ...forbidden("view", DRIVERS) },
      }),
      guard,
      requireGrant(DRIVERS, "view"),
      validate("query", DriverAbsenceListQuery),
      async (c) => {
        const { limit, cursor, projectId, driverId, from, to } = c.req.valid("query")
        const after = afterCursor(cursor)
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await c
          .get("tx")
          .select(absenceColumns)
          .from(driverAbsence)
          .where(
            and(
              absenceScope(principal),
              projectId === undefined ? undefined : eq(driverAbsence.projectId, projectId),
              driverId === undefined ? undefined : eq(driverAbsence.driverId, driverId),
              touching(driverAbsence.validFrom, driverAbsence.validTo, from, to),
              after === undefined ? undefined : gt(driverAbsence.id, after),
            ),
          )
          .orderBy(asc(driverAbsence.id))
          .limit(fetchLimit(limit))
        const { items, nextCursor } = pageOf(rows, limit)
        return c.json({ items: items.map(absenceOf), nextCursor })
      },
    )
    .post(
      "/driver-absences",
      describeRoute({
        operationId: "createDriverAbsence",
        summary: "Record a driver's absence",
        description: `Records that a driver of a project the caller works in is away over a period, with why (\`holiday\`, \`sick\`, \`training\`, \`leave\`, \`other\`) and a note; the absence lives in the driver's project. A driver of another project is refused (400 at \`driverId\`). ${PERIOD_RULES}${NEVER_REFUSED_FOR_WORK} The server mints the id.`,
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The absence as recorded.", DriverAbsence),
          400: describeProblem("The body is missing a field, names a member the server owns, names a driver of no project this account works in, or ends on or before the day it starts."),
          ...unauthenticated,
          ...forbidden("create", DRIVERS),
          409: describeProblem("The driver is already absent on one of those days; the detail names that absence."),
        },
      }),
      guard,
      requireGrant(DRIVERS, "create"),
      validate("json", DriverAbsenceCreate),
      async (c) => {
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const who = await driverHere(tx, principal, body.driverId)
        const period = periodOf(body)
        const already = await awayOver(tx, "driver", { companyId: principal.companyId, projectId: who.projectId }, who.id, period)
        if (already !== undefined) throw problem(409, { detail: alreadyAbsent(who.name, already) })
        const [row] = await refuseOverlap({ driver_absence_no_overlap: DRIVER_AWAY_ALREADY }, () =>
          tx
            .insert(driverAbsence)
            .values({ id: newId(), companyId: principal.companyId, projectId: who.projectId, driverId: who.id, ...period, reason: body.reason, note: body.note ?? null })
            .returning(absenceColumns),
        )
        return created(c, "/driver-absences", absenceOf(row))
      },
    )
    .get(
      "/driver-absences/:id",
      describeRoute({
        operationId: "getDriverAbsence",
        summary: "One driver absence",
        description: "One absence of a driver of a project the caller works in. One of another company, or of a project this account does not work in, is one that does not exist here.",
        security: BEARER_SECURITY,
        responses: { 200: describeJson("The absence.", DriverAbsence), 400: describeProblem("The path does not hold an id."), ...unauthenticated, ...forbidden("view", DRIVERS), 404: describeProblem("No driver absence with that id in the projects this account works in.") },
      }),
      guard,
      requireGrant(DRIVERS, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findAbsence(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchAbsence(id)
        return c.json(absenceOf(row))
      },
    )
    .patch(
      "/driver-absences/:id",
      describeRoute({
        operationId: "patchDriverAbsence",
        summary: "Move a driver's absence",
        description: `Moves the period, the reason or the note of an absence; never whose it is. ${PERIOD_RULES} The period the patch leaves behind — the body's bounds over the stored ones — is what is judged. Under the absence's row lock.`,
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The absence as it now stands.", DriverAbsence),
          400: describeProblem("The path does not hold an id, or the body changes nothing, names a member it does not take, or leaves a period ending on or before the day it starts."),
          ...unauthenticated,
          ...forbidden("edit", DRIVERS),
          404: describeProblem("No driver absence with that id in the projects this account works in."),
          409: describeProblem("The driver is already absent on one of the days the period now covers; the detail names that absence."),
        },
      }),
      guard,
      requireGrant(DRIVERS, "edit"),
      validate("param", IdParam),
      validate("json", DriverAbsencePatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        await lockRow(tx, driverAbsence, { companyId: principal.companyId, id })
        const current = await findAbsence(tx, principal, id)
        if (current === undefined) throw noSuchAbsence(id)
        const period = periodAfter(current, body)
        requireOrdered(period)
        const scope = { companyId: principal.companyId, projectId: current.projectId }
        const already = await awayOver(tx, "driver", scope, current.driverId, period, current.id)
        if (already !== undefined) throw problem(409, { detail: alreadyAbsent(await driverName(tx, scope, current.driverId), already) })
        const [row] = await refuseOverlap({ driver_absence_no_overlap: DRIVER_AWAY_ALREADY }, () =>
          tx
            .update(driverAbsence)
            .set({ ...period, ...(body.reason === undefined ? {} : { reason: body.reason }), ...(body.note === undefined ? {} : { note: body.note }) })
            .where(and(absenceScope(principal), eq(driverAbsence.id, id)))
            .returning(absenceColumns),
        )
        if (row === undefined) throw noSuchAbsence(id)
        return c.json(absenceOf(row))
      },
    )
    .delete(
      "/driver-absences/:id",
      describeRoute({
        operationId: "deleteDriverAbsence",
        summary: "Remove a driver's absence",
        description:
          "Removes an absence recorded wrongly — nothing references a period, and the audit trail keeps what it was, under the driver's history. The driver is there again on its days; the next generation run puts a group's driver back on its planned, unheld routes. Answers 204 with no body.",
        security: BEARER_SECURITY,
        responses: { 204: { description: "The absence is removed." }, 400: describeProblem("The path does not hold an id."), ...unauthenticated, ...forbidden("delete", DRIVERS), 404: describeProblem("No driver absence with that id in the projects this account works in.") },
      }),
      guard,
      requireGrant(DRIVERS, "delete"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const principal = c.get("principal")
        const [gone] = await c.get("tx").delete(driverAbsence).where(and(absenceScope(principal), eq(driverAbsence.id, id))).returning({ id: driverAbsence.id })
        if (gone === undefined) throw noSuchAbsence(id)
        return c.body(null, 204)
      },
    )
    .get(
      "/vehicle-unavailability",
      describeRoute({
        operationId: "listVehicleUnavailability",
        summary: "When the vehicles of the caller's projects are out of use",
        description:
          "One page of vehicle unavailability — a powered vehicle's or a trailer's — oldest first, from the projects the caller works in. `projectId` narrows it to one of those projects, `vehicleId` to one vehicle, and `from` and `to` (both inclusive) to the periods touching that window of days. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: { 200: describeJson("One page of unavailability.", VehicleUnavailabilityPage), ...page, ...forbidden("view", VEHICLES) },
      }),
      guard,
      requireGrant(VEHICLES, "view"),
      validate("query", VehicleUnavailabilityListQuery),
      async (c) => {
        const { limit, cursor, projectId, vehicleId, from, to } = c.req.valid("query")
        const after = afterCursor(cursor)
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await c
          .get("tx")
          .select(unavailabilityColumns)
          .from(vehicleUnavailability)
          .where(
            and(
              unavailabilityScope(principal),
              projectId === undefined ? undefined : eq(vehicleUnavailability.projectId, projectId),
              vehicleId === undefined ? undefined : eq(vehicleUnavailability.vehicleId, vehicleId),
              touching(vehicleUnavailability.validFrom, vehicleUnavailability.validTo, from, to),
              after === undefined ? undefined : gt(vehicleUnavailability.id, after),
            ),
          )
          .orderBy(asc(vehicleUnavailability.id))
          .limit(fetchLimit(limit))
        const { items, nextCursor } = pageOf(rows, limit)
        return c.json({ items: items.map(unavailabilityOf), nextCursor })
      },
    )
    .post(
      "/vehicle-unavailability",
      describeRoute({
        operationId: "createVehicleUnavailability",
        summary: "Record when a vehicle is out of use",
        description: `Records that a vehicle or a trailer of a project the caller works in is out of use over a period, with why (\`maintenance\`, \`repair\`, \`inspection\`, \`breakdown\`, \`other\`) and a note; the period lives in the vehicle's project. A vehicle of another project is refused (400 at \`vehicleId\`). ${PERIOD_RULES}${NEVER_REFUSED_FOR_WORK} The server mints the id.`,
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The period as recorded.", VehicleUnavailability),
          400: describeProblem("The body is missing a field, names a member the server owns, names a vehicle of no project this account works in, or ends on or before the day it starts."),
          ...unauthenticated,
          ...forbidden("create", VEHICLES),
          409: describeProblem("The vehicle is already unavailable on one of those days; the detail names that period."),
        },
      }),
      guard,
      requireGrant(VEHICLES, "create"),
      validate("json", VehicleUnavailabilityCreate),
      async (c) => {
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const what = await vehicleHere(tx, principal, body.vehicleId)
        const period = periodOf(body)
        const already = await awayOver(tx, "vehicle", { companyId: principal.companyId, projectId: what.projectId }, what.id, period)
        if (already !== undefined) throw problem(409, { detail: alreadyUnavailable(what.label, already) })
        const [row] = await refuseOverlap({ vehicle_unavailability_no_overlap: VEHICLE_AWAY_ALREADY }, () =>
          tx
            .insert(vehicleUnavailability)
            .values({ id: newId(), companyId: principal.companyId, projectId: what.projectId, vehicleId: what.id, ...period, reason: body.reason, note: body.note ?? null })
            .returning(unavailabilityColumns),
        )
        return created(c, "/vehicle-unavailability", unavailabilityOf(row))
      },
    )
    .get(
      "/vehicle-unavailability/:id",
      describeRoute({
        operationId: "getVehicleUnavailability",
        summary: "One period a vehicle is out of use",
        description: "One period of unavailability of a vehicle of a project the caller works in. One of another company, or of a project this account does not work in, is one that does not exist here.",
        security: BEARER_SECURITY,
        responses: { 200: describeJson("The period.", VehicleUnavailability), 400: describeProblem("The path does not hold an id."), ...unauthenticated, ...forbidden("view", VEHICLES), 404: describeProblem("No vehicle unavailability with that id in the projects this account works in.") },
      }),
      guard,
      requireGrant(VEHICLES, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findUnavailability(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchUnavailability(id)
        return c.json(unavailabilityOf(row))
      },
    )
    .patch(
      "/vehicle-unavailability/:id",
      describeRoute({
        operationId: "patchVehicleUnavailability",
        summary: "Move when a vehicle is out of use",
        description: `Moves the period, the reason or the note; never whose it is. ${PERIOD_RULES} The period the patch leaves behind is what is judged. Under the row's lock.`,
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The period as it now stands.", VehicleUnavailability),
          400: describeProblem("The path does not hold an id, or the body changes nothing, names a member it does not take, or leaves a period ending on or before the day it starts."),
          ...unauthenticated,
          ...forbidden("edit", VEHICLES),
          404: describeProblem("No vehicle unavailability with that id in the projects this account works in."),
          409: describeProblem("The vehicle is already unavailable on one of the days the period now covers; the detail names that period."),
        },
      }),
      guard,
      requireGrant(VEHICLES, "edit"),
      validate("param", IdParam),
      validate("json", VehicleUnavailabilityPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        await lockRow(tx, vehicleUnavailability, { companyId: principal.companyId, id })
        const current = await findUnavailability(tx, principal, id)
        if (current === undefined) throw noSuchUnavailability(id)
        const period = periodAfter(current, body)
        requireOrdered(period)
        const scope = { companyId: principal.companyId, projectId: current.projectId }
        const already = await awayOver(tx, "vehicle", scope, current.vehicleId, period, current.id)
        if (already !== undefined) throw problem(409, { detail: alreadyUnavailable(await vehicleName(tx, scope, current.vehicleId), already) })
        const [row] = await refuseOverlap({ vehicle_unavailability_no_overlap: VEHICLE_AWAY_ALREADY }, () =>
          tx
            .update(vehicleUnavailability)
            .set({ ...period, ...(body.reason === undefined ? {} : { reason: body.reason }), ...(body.note === undefined ? {} : { note: body.note }) })
            .where(and(unavailabilityScope(principal), eq(vehicleUnavailability.id, id)))
            .returning(unavailabilityColumns),
        )
        if (row === undefined) throw noSuchUnavailability(id)
        return c.json(unavailabilityOf(row))
      },
    )
    .delete(
      "/vehicle-unavailability/:id",
      describeRoute({
        operationId: "deleteVehicleUnavailability",
        summary: "Remove a period a vehicle was out of use",
        description:
          "Removes a period recorded wrongly — nothing references it, and the audit trail keeps what it was, under the vehicle's history. The vehicle is there again on its days; the next generation run puts a group's vehicle back on its planned, unheld routes. Answers 204 with no body.",
        security: BEARER_SECURITY,
        responses: { 204: { description: "The period is removed." }, 400: describeProblem("The path does not hold an id."), ...unauthenticated, ...forbidden("delete", VEHICLES), 404: describeProblem("No vehicle unavailability with that id in the projects this account works in.") },
      }),
      guard,
      requireGrant(VEHICLES, "delete"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const principal = c.get("principal")
        const [gone] = await c.get("tx").delete(vehicleUnavailability).where(and(unavailabilityScope(principal), eq(vehicleUnavailability.id, id))).returning({ id: vehicleUnavailability.id })
        if (gone === undefined) throw noSuchUnavailability(id)
        return c.body(null, 204)
      },
    )
}
