// The tank register (M11 of #293): a Property's septic tanks, holding tanks,
// small treatment plants and grease separators, each the Container that
// stands for it in the plan, and the office's inspections of them.
// `GET`/`POST /tank-installations`, `GET`/`PATCH /tank-installations/:id`,
// and a tank's inspections under it: `GET`/`POST
// /tank-installations/:id/inspections`, a ledger appended and never
// rewritten. There is no delete: a tank taken out of use ends there
// (`validTo`), and its stops and inspections keep naming it.
//
// The rules: the Property is one of a project the caller works in, and the
// Container one of that project; on the tank's first day the container's
// placement serves the Property — its subscription is the Property's — so
// the tank is planned, stopped at and billed where it is (a 409 naming the
// day); and a container stands for one tank at a time (a 409 from the
// exclusion constraint). The Property's lock comes first, parent before
// child, for a create, a patch and an inspection alike.
//
// The read answers what the due-from-last cadence reckons from: the last
// emptying, the container's latest completed stop with the litres recorded
// there (`lastEmptyings`, @waste/db/query/tank-emptyings, the reading
// generation plans from too), and the day the next is due (`tankDueOn`).
//
// The grant is the Property's module, `customers.properties`: `view` to read,
// `edit` for every write, since a tank is part of the Property it serves.
import { Page, PageRequest } from "@waste/contracts/pagination"
import {
  TankInspection,
  TankInspectionCreate,
  TankInstallation,
  TankInstallationCreate,
  TankInstallationListQuery,
  TankInstallationPatch,
  type TankInspectionOutcome,
  type TankKind,
  type TankOutlet,
} from "@waste/contracts/tanks"
import { ENDS_AFTER_IT_STARTS } from "@waste/contracts/validity"
import type { Tx } from "@waste/db/client"
import { lastEmptyings, type TankEmptying } from "@waste/db/query/tank-emptyings"
import { validOn } from "@waste/db/query/valid-on"
import { subscription } from "@waste/db/schema/agreements"
import { container, containerServicePlacement } from "@waste/db/schema/containers"
import { property } from "@waste/db/schema/customers"
import { tankInspection, tankInstallation } from "@waste/db/schema/tanks"
import { tankDueOn } from "@waste/domain/route-schemes/due-from-last"
import { and, asc, eq, gt } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { projectToday } from "./fleet-lookups"
import type { ClockOptions } from "./scheme-groups"
import { created, describeCreated, describeJson, IdParam, lockRow, refuseOverlap, stampsOf } from "./shared"

const MODULE = "customers.properties"
const TankPage = Page(TankInstallation)
const InspectionPage = Page(TankInspection)

/** `EXCLUDE USING gist (company_id, container_id, daterange)`: a container stands for one tank at a time. */
const ANOTHER_TANK = "tank_installation_no_overlap"
export const standsForAnotherTank = (label: string) => `${label} stands for another tank over part of that period`
export const notPlacedAt = (label: string, place: string, day: string) => `${label} is not placed at ${place} on ${day}; a tank's container serves its property`
export const INSPECTED_BY_TODAY = "An inspection is recorded on or after the day it was made"

const noSuchTank = (id: string) => problem(404, { detail: `No tank installation ${id} in the projects this account works in` })

const columns = {
  id: tankInstallation.id,
  projectId: tankInstallation.projectId,
  propertyId: tankInstallation.propertyId,
  containerId: tankInstallation.containerId,
  kind: tankInstallation.kind,
  volumeLitres: tankInstallation.volumeLitres,
  outlet: tankInstallation.outlet,
  emptyingIntervalMonths: tankInstallation.emptyingIntervalMonths,
  lastEmptiedOn: tankInstallation.lastEmptiedOn,
  notes: tankInstallation.notes,
  validFrom: tankInstallation.validFrom,
  validTo: tankInstallation.validTo,
  createdAt: tankInstallation.createdAt,
  updatedAt: tankInstallation.updatedAt,
}

type Row = Pick<typeof tankInstallation.$inferSelect, keyof typeof columns>

/** The later of two days, either of which may be absent. */
const later = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a > b ? a : b)

/** The row on the wire, with its last emptying and the day the next is due. */
const tankOf = (row: Row, emptying: TankEmptying | undefined): TankInstallation => ({
  id: row.id,
  projectId: row.projectId,
  validFrom: row.validFrom,
  validTo: row.validTo,
  propertyId: row.propertyId,
  containerId: row.containerId,
  kind: row.kind as TankKind,
  volumeLitres: row.volumeLitres,
  outlet: row.outlet as TankOutlet,
  emptyingIntervalMonths: row.emptyingIntervalMonths,
  lastEmptiedOn: row.lastEmptiedOn,
  notes: row.notes,
  lastEmptying: emptying ?? null,
  dueOn: tankDueOn({ lastEmptiedOn: later(emptying?.on ?? null, row.lastEmptiedOn), intervalMonths: row.emptyingIntervalMonths }),
  ...stampsOf(row),
})

/** Rows on the wire, their last emptyings read in one statement. */
async function answered(tx: Tx, companyId: string, rows: readonly Row[]): Promise<TankInstallation[]> {
  const emptyings = await lastEmptyings(tx, companyId, [...new Set(rows.map((row) => row.containerId))])
  return rows.map((row) => tankOf(row, emptyings.get(row.containerId)))
}

const scope = (principal: Principal) => and(eq(tankInstallation.companyId, principal.companyId), inProjects(tankInstallation.projectId, principal))

async function findTank(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx.select(columns).from(tankInstallation).where(and(scope(principal), eq(tankInstallation.id, id))).limit(1)
  return row
}

/** The tank's locks, its Property's first, top down; then the tank read again underneath them. */
async function lockedTank(tx: Tx, principal: Principal, found: Row): Promise<Row> {
  await lockRow(tx, property, { companyId: principal.companyId, id: found.propertyId })
  await lockRow(tx, tankInstallation, { companyId: principal.companyId, id: found.id })
  const current = await findTank(tx, principal, found.id)
  if (current === undefined) throw noSuchTank(found.id)
  return current
}

const inspectionColumns = {
  id: tankInspection.id,
  recordedAt: tankInspection.recordedAt,
  projectId: tankInspection.projectId,
  tankInstallationId: tankInspection.tankInstallationId,
  inspectedOn: tankInspection.inspectedOn,
  outcome: tankInspection.outcome,
  findings: tankInspection.findings,
  nextInspectionOn: tankInspection.nextInspectionOn,
  recordedBy: tankInspection.recordedBy,
}

const inspectionOf = (row: Pick<typeof tankInspection.$inferSelect, keyof typeof inspectionColumns>): TankInspection => ({
  id: row.id,
  recordedAt: row.recordedAt.toISOString(),
  projectId: row.projectId,
  tankInstallationId: row.tankInstallationId,
  inspectedOn: row.inspectedOn,
  outcome: row.outcome as TankInspectionOutcome,
  findings: row.findings,
  nextInspectionOn: row.nextInspectionOn,
  recordedBy: row.recordedBy,
})

export function tankRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date() }: ClockOptions = {}) {
  return new Hono<AuthEnv>()
    .get(
      "/tank-installations",
      describeRoute({
        operationId: "listTankInstallations",
        summary: "The tank installations of the caller's projects",
        description:
          "One page of tank installations, oldest first (ids are time-ordered), from the projects the caller works in — an account that works in none reads an empty page. `projectId` narrows it to one of those projects, naming another being refused; `propertyId` to one Property's tanks; `containerId` to the tanks one container has stood for; `validOn` to those in force on that day, `validFrom` inclusive and `validTo` exclusive. Each carries its last emptying — its container's latest completed stop, with the litres recorded there — and `dueOn`, the day the next falls due: the last emptying, or before there is one the register's `lastEmptiedOn`, plus `emptyingIntervalMonths`; null for a tank never emptied, which is due now. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of tank installations.", TankPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a filter is malformed, or `projectId` is not a project this account works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `customers.properties`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", TankInstallationListQuery),
      async (c) => {
        const { limit, cursor, projectId, propertyId, containerId, validOn: day } = c.req.valid("query")
        const after = afterCursor(cursor)
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const tx = c.get("tx")
        const rows = await tx
          .select(columns)
          .from(tankInstallation)
          .where(
            and(
              scope(principal),
              projectId === undefined ? undefined : eq(tankInstallation.projectId, projectId),
              propertyId === undefined ? undefined : eq(tankInstallation.propertyId, propertyId),
              containerId === undefined ? undefined : eq(tankInstallation.containerId, containerId),
              day === undefined ? undefined : validOn(tankInstallation, day),
              after === undefined ? undefined : gt(tankInstallation.id, after),
            ),
          )
          .orderBy(asc(tankInstallation.id))
          .limit(fetchLimit(limit))
        const page = pageOf(rows, limit)
        return c.json({ ...page, items: await answered(tx, principal.companyId, page.items) })
      },
    )
    .post(
      "/tank-installations",
      describeRoute({
        operationId: "createTankInstallation",
        summary: "Register a tank at a Property",
        description:
          "Registers a tank at a Property of a project the caller works in (400 at `propertyId` otherwise): what it is, what it holds in whole litres, where it lets its water out, the months between emptyings, and, for a tank emptied before the platform knew it, `lastEmptiedOn`. `containerId` is the Container that stands for it in the plan, of the Property's project (400 at `containerId` otherwise), whose placement on `validFrom` serves the Property — its subscription is the Property's (409 naming the day otherwise) — so the tank is planned, stopped at and billed as any container is. A container stands for one tank at a time (409). Answers the tank with its `Location`. Under the Property's lock.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The tank as it was written, with its last emptying and the day the next is due.", TankInstallation),
          400: describeProblem("The body is missing a field, holds a value of the wrong shape, names one the server owns, ends on or before the day it starts, or names a Property or a Container this account cannot use."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `customers.properties`."),
          409: describeProblem("The container is not placed at the Property on the tank's first day, or stands for another tank over part of the period."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("json", TankInstallationCreate),
      async (c) => {
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const [place] = await tx
          .select({ id: property.id, projectId: property.projectId, name: property.name })
          .from(property)
          .where(and(eq(property.companyId, principal.companyId), inProjects(property.projectId, principal), eq(property.id, body.propertyId)))
          .limit(1)
        if (place === undefined) throw invalidRequest("body", [{ path: "propertyId", message: `No property ${body.propertyId} in the projects this account works in` }])
        await lockRow(tx, property, { companyId: principal.companyId, id: place.id })
        const [bin] = await tx
          .select({ id: container.id, label: container.label })
          .from(container)
          .where(and(eq(container.companyId, principal.companyId), eq(container.projectId, place.projectId), eq(container.id, body.containerId)))
          .limit(1)
        if (bin === undefined) throw invalidRequest("body", [{ path: "containerId", message: "Not a container of the property's project" }])
        const [serving] = await tx
          .select({ propertyId: subscription.propertyId })
          .from(containerServicePlacement)
          .innerJoin(subscription, and(eq(subscription.companyId, containerServicePlacement.companyId), eq(subscription.id, containerServicePlacement.subscriptionId)))
          .where(and(eq(containerServicePlacement.companyId, principal.companyId), eq(containerServicePlacement.containerId, bin.id), validOn(containerServicePlacement, body.validFrom)))
          .limit(1)
        if (serving?.propertyId !== place.id) throw problem(409, { detail: notPlacedAt(bin.label, place.name, body.validFrom) })
        const [row] = await refuseOverlap({ [ANOTHER_TANK]: standsForAnotherTank(bin.label) }, () =>
          tx
            .insert(tankInstallation)
            .values({ ...body, id: newId(), companyId: principal.companyId, projectId: place.projectId })
            .returning(columns),
        )
        const [tank] = await answered(tx, principal.companyId, [row])
        return created(c, "/tank-installations", tank)
      },
    )
    .get(
      "/tank-installations/:id",
      describeRoute({
        operationId: "getTankInstallation",
        summary: "One tank installation",
        description: "One tank installation of a project the caller works in, with its last emptying and the day the next is due.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The tank installation.", TankInstallation),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `customers.properties`."),
          404: describeProblem("No tank installation with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findTank(tx, principal, id)
        if (row === undefined) throw noSuchTank(id)
        const [tank] = await answered(tx, principal.companyId, [row])
        return c.json(tank)
      },
    )
    .patch(
      "/tank-installations/:id",
      describeRoute({
        operationId: "patchTankInstallation",
        summary: "Change a tank installation",
        description:
          "Changes one tank installation; every field is optional and at least one must be given. Its Property, its Container and its first day are set once. `validTo` ends it — a tank taken out of use — after its first day (400 at `validTo`), or null runs it on; a container stands for one tank at a time (409). A changed interval or `lastEmptiedOn` moves the day the next emptying is due, which the next generation run plans from. Under the Property's lock and then the tank's.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The tank installation as it now stands.", TankInstallation),
          400: describeProblem("The path does not hold an id, or the patch is empty, names a field the caller does not own, holds a value of the wrong shape, or ends the tank on or before its first day."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `customers.properties`."),
          404: describeProblem("No tank installation with that id in the projects this account works in."),
          409: describeProblem("The container stands for another tank over part of the new period."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", TankInstallationPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const found = await findTank(tx, principal, id)
        if (found === undefined) throw noSuchTank(id)
        const current = await lockedTank(tx, principal, found)
        if (patch.validTo != null && patch.validTo <= current.validFrom) throw invalidRequest("body", [{ path: "validTo", message: ENDS_AFTER_IT_STARTS }])
        const [bin] = await tx.select({ label: container.label }).from(container).where(and(eq(container.companyId, principal.companyId), eq(container.id, current.containerId))).limit(1)
        const [row] = await refuseOverlap({ [ANOTHER_TANK]: standsForAnotherTank(bin?.label ?? current.containerId) }, () =>
          tx
            .update(tankInstallation)
            .set(patch)
            .where(and(eq(tankInstallation.companyId, principal.companyId), eq(tankInstallation.id, id)))
            .returning(columns),
        )
        const [tank] = await answered(tx, principal.companyId, [row])
        return c.json(tank)
      },
    )
    .get(
      "/tank-installations/:id/inspections",
      describeRoute({
        operationId: "listTankInspections",
        summary: "A tank's inspections",
        description: "One page of a tank installation's inspections, oldest first (ids are time-ordered). Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of inspections.", InspectionPage),
          400: describeProblem("The path does not hold an id, the page size is outside 1..200, or the cursor is not one this API wrote."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `customers.properties`."),
          404: describeProblem("No tank installation with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      validate("query", PageRequest),
      async (c) => {
        const { id } = c.req.valid("param")
        const { limit, cursor } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        const tank = await findTank(tx, principal, id)
        if (tank === undefined) throw noSuchTank(id)
        const rows = await tx
          .select(inspectionColumns)
          .from(tankInspection)
          .where(and(eq(tankInspection.companyId, principal.companyId), eq(tankInspection.tankInstallationId, tank.id), after === undefined ? undefined : gt(tankInspection.id, after)))
          .orderBy(asc(tankInspection.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(inspectionOf), limit))
      },
    )
    .post(
      "/tank-installations/:id/inspections",
      describeRoute({
        operationId: "recordTankInspection",
        summary: "Record a tank's inspection",
        description:
          "Appends what an inspection of the tank found: the day it was made, on the project's clock today or before (400 at `inspectedOn`), the outcome — `approved`, `remarks`, `defects` or `failed` — the findings, and when the tank is next to be inspected, after the day (400 at `nextInspectionOn`). Recorded by the caller; never rewritten. Under the Property's lock and then the tank's.",
        security: BEARER_SECURITY,
        responses: {
          201: describeJson("The inspection as it was appended.", TankInspection),
          400: describeProblem("The path does not hold an id, or the body is missing a field, holds a value of the wrong shape, names one the server owns, is dated after today, or names its next inspection on or before it."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `customers.properties`."),
          404: describeProblem("No tank installation with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", TankInspectionCreate),
      async (c) => {
        const { id } = c.req.valid("param")
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const found = await findTank(tx, principal, id)
        if (found === undefined) throw noSuchTank(id)
        const tank = await lockedTank(tx, principal, found)
        const today = await projectToday(tx, { companyId: principal.companyId, projectId: tank.projectId }, now)()
        if (body.inspectedOn > today) throw invalidRequest("body", [{ path: "inspectedOn", message: INSPECTED_BY_TODAY }])
        const [row] = await tx
          .insert(tankInspection)
          .values({ ...body, id: newId(), companyId: principal.companyId, projectId: tank.projectId, tankInstallationId: tank.id, recordedBy: principal.user.id })
          .returning(inspectionColumns)
        return c.json(inspectionOf(row), 201)
      },
    )
}
