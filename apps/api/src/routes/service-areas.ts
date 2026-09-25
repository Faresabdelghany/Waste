// Who serves where (Issue #112, ADR-0001, ADR-0005): the Service Area and
// its Assignment. `GET /service-areas` lists the awards, `POST /service-areas`
// makes one, `GET`/`PATCH /service-areas/:id` read and amend one, `PUT
// /service-areas/:id/planning-areas` and `PUT /service-areas/:id/waste-fractions`
// replace its two sets; `GET`/`POST /service-areas/:id/assignments` read and
// add who holds it, `GET /service-area-assignments` reads the assignments
// across a project's areas — and a provider's own — and `GET`/`PATCH
// /service-area-assignments/:id` read and amend one. No delete anywhere: an
// award ends by `validTo`, an assignment too, and a transfer is the old one
// ended on the day and a new one from it — "Assigning or transferring it
// changes the relationship and preserves the Service Area itself".
//
// The area is the award as the glossary states it: its geography by
// reference to Planning Areas, the legal boundary as text, its scope as
// waste fractions, no polygon and no products (a provider is paid per product
// through its prices, not scoped by them), and no status — Draft, Upcoming,
// Active, Expiring and Expired are readings of the period against a day.
// One area of a code is in force at a time (`service_area_no_overlap`), so
// an award re-let is a new row of the code. The two sets travel with the
// record and are replaced whole, through routes/id-sets.ts's mechanics: a
// page's sets in one query each, a body's ids held to what their key allows
// in one statement — a planning area the project's, a fraction the
// company's — the record's row stamped first, delete-then-insert inside the
// request's transaction, the answer the validated ids in read order. The
// planning-area set is spelled step by step rather than through
// `replaceIdSet`, because the one-award rule runs between the ids being
// proved and the set being written, and because the rows carry the project,
// which `Owner` does not.
//
// The one-award rule (§3, §7.20): a planning area is awarded once at a time.
// The create, the planning-area PUT and a patch that widens the period refuse
// a planning area that another area of the project names while the two
// periods overlap — a 409 at the entry, "Planning area OP-CEN-01 is already
// in service area CA-Ø-2 over part of that period" — held under both areas'
// locks: `lockRow` on this area, then `select … for update` of the areas the
// check found, in id order, so two areas claiming each other's planning area
// take turns. The database does not hold this one, since the constraint
// would put a period on the membership row; that is why the lock is spelled.
//
// The assignment is the effective-dated relationship: who holds the area
// when. One provider holds an area at a time (`service_area_assignment_no_overlap`),
// and its period lies inside the area's — routes/periods.ts's two rules under
// the area's row lock: an assignment put outside is a 400 naming the bound,
// an area shortened under its assignments a 409 counting them, and an
// assignment shortened under its provider prices likewise. The first
// assignment may ride on the area's create, since an award is made to
// someone, written in the same transaction — a refused provider takes the
// area with it — and answered beside it (`ServiceAreaCreated`, the
// `PlanningAreaCreated` precedent).
//
// Two scopes, because this is the first office family a Service Provider's
// account reaches (auth/provider.ts, §7.22). The office reads and writes
// through `inProjects`, as every project-scoped family does. A provider's
// account works in no project and reads its own: the assignments naming its
// provider (`reachesAssignments`) and the areas they name — a single read
// outside that is the family's 404 — and writes nothing here, since the
// award is the company's to make and to move; its writes find no row. The
// grant is `service-providers.service-areas` throughout, the sets and the
// assignments included.
import { Page } from "@waste/contracts/pagination"
import {
  ServiceArea,
  ServiceAreaAssignment,
  ServiceAreaAssignmentCreate,
  ServiceAreaAssignmentListQuery,
  ServiceAreaAssignmentPatch,
  ServiceAreaCreate,
  ServiceAreaCreated,
  ServiceAreaDetail,
  ServiceAreaListQuery,
  ServiceAreaPatch,
  ServiceAreaPlanningAreasSet,
  ServiceAreaWasteFractionsSet,
} from "@waste/contracts/service-areas"
import type { Tx } from "@waste/db/client"
import { validOn } from "@waste/db/query/valid-on"
import { wasteFraction } from "@waste/db/schema/catalogue"
import { serviceArea, serviceAreaAssignment, serviceAreaPlanningArea, serviceAreaWasteFraction, serviceProviderPrice } from "@waste/db/schema/finance"
import { planningArea } from "@waste/db/schema/planning-areas"
import { count } from "@waste/domain/text"
import { and, asc, eq, exists, gt, inArray, ne, sql, type SQL } from "drizzle-orm"
import { alias, type PgColumn } from "drizzle-orm/pg-core"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"
import * as z from "zod"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { providerIdOf, reachesAssignments } from "../auth/provider"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { asRead, idsFor, idsOf, replaceIdSet, requireEachOf, writeIds, type IdSet, type IdSetColumns } from "./id-sets"
import { notWithin, periodAfter, periodOf, refuseStranded, requireOrdered, requireWithin, type Period } from "./periods"
import { requirePlanningArea, requireServiceProvider, requireWasteFraction } from "./references"
import { eachPresent } from "./sets"
import { created, describeCreated, describeJson, IdParam, lockRow, refuseOverlap, stamp, stampsOf } from "./shared"

const MODULE = "service-providers.service-areas"
const ServiceAreaPage = Page(ServiceArea)
const AssignmentPage = Page(ServiceAreaAssignment)
/** One area's assignments, earliest first: the detail's list on its own. */
const Assignments = z.array(ServiceAreaAssignment)

const columns = {
  id: serviceArea.id,
  projectId: serviceArea.projectId,
  code: serviceArea.code,
  name: serviceArea.name,
  boundaryText: serviceArea.boundaryText,
  notes: serviceArea.notes,
  validFrom: serviceArea.validFrom,
  validTo: serviceArea.validTo,
  createdAt: serviceArea.createdAt,
  updatedAt: serviceArea.updatedAt,
}

type Row = Pick<typeof serviceArea.$inferSelect, keyof typeof columns>

/** The two sets an area carries, each by id. */
type Sets = { planningAreaIds: readonly string[]; wasteFractionIds: readonly string[] }

/** The area on the wire, with the two sets the page loaded for it. */
function areaOf(row: Row, sets: Sets): ServiceArea {
  return {
    id: row.id,
    projectId: row.projectId,
    code: row.code,
    name: row.name,
    boundaryText: row.boundaryText,
    notes: row.notes,
    planningAreaIds: [...sets.planningAreaIds],
    wasteFractionIds: [...sets.wasteFractionIds],
    validFrom: row.validFrom,
    validTo: row.validTo,
    ...stampsOf(row),
  }
}

const assignmentColumns = {
  id: serviceAreaAssignment.id,
  projectId: serviceAreaAssignment.projectId,
  serviceAreaId: serviceAreaAssignment.serviceAreaId,
  serviceProviderId: serviceAreaAssignment.serviceProviderId,
  notes: serviceAreaAssignment.notes,
  validFrom: serviceAreaAssignment.validFrom,
  validTo: serviceAreaAssignment.validTo,
  createdAt: serviceAreaAssignment.createdAt,
  updatedAt: serviceAreaAssignment.updatedAt,
}

type AssignmentRow = Pick<typeof serviceAreaAssignment.$inferSelect, keyof typeof assignmentColumns>

/** The assignment on the wire. */
function assignmentOf(row: AssignmentRow): ServiceAreaAssignment {
  return {
    id: row.id,
    projectId: row.projectId,
    serviceAreaId: row.serviceAreaId,
    serviceProviderId: row.serviceProviderId,
    notes: row.notes,
    validFrom: row.validFrom,
    validTo: row.validTo,
    ...stampsOf(row),
  }
}

/** The area a set or an assignment hangs on, and the scope every row of it inherits. */
type Parent = { companyId: string; projectId: string; id: string }

/** `EXCLUDE USING gist (company_id, project_id, code, daterange)`: one area of a code is in force at a time, and a re-let award is the next row. */
const AREA_RUNNING = "service_area_no_overlap"
const AREA_RUNNING_SENTENCE = "A service area of this code is already in force over part of that period"

/** `EXCLUDE USING gist (company_id, service_area_id, daterange)`: one provider holds an area at a time; a transfer is the old assignment ended on the day and the new one from it. */
const ASSIGNMENT_RUNNING = "service_area_assignment_no_overlap"
const ASSIGNMENT_RUNNING_SENTENCE = "This service area is already assigned over part of that period; end the assignment first"

/** What an assignment put outside its area's period is refused with, at the bound the caller chose. */
export const OUTSIDE_SERVICE_AREA = "Outside the service area's period"

/** What an area shortened under its assignments is refused with; the rows in the way are not in the body, so the caller ends them first. */
const strandedAssignments = (rows: number) => `${count(rows, "assignment")} ${rows === 1 ? "falls" : "fall"} outside the new period; end ${rows === 1 ? "it" : "them"} first`

/** The same for an assignment shortened under its provider prices. */
const strandedPrices = (rows: number) => `${count(rows, "service provider price")} ${rows === 1 ? "falls" : "fall"} outside the new period; end ${rows === 1 ? "it" : "them"} first`

/** The one-award rule's sentence: the planning area by its code, the other area by its. */
export const awardedElsewhere = (planningAreaCode: string, serviceAreaCode: string): string => `Planning area ${planningAreaCode} is already in service area ${serviceAreaCode} over part of that period`

const noSuchArea = (id: string) => problem(404, { detail: `No service area ${id} this account reaches` })
const noSuchAssignment = (id: string) => problem(404, { detail: `No service area assignment ${id} this account reaches` })

/** The assignments the caller reaches: its provider's, or its projects' (auth/provider.ts). */
const assignmentReach = (principal: Principal) => and(eq(serviceAreaAssignment.companyId, principal.companyId), reachesAssignments(principal))

/** The assignments of one area the caller reaches: a subquery for the area's read and for a provider's area scope. */
const reachableAssignmentsOf = (tx: Tx, principal: Principal, where: SQL | undefined) =>
  tx
    .select({ one: sql`1` })
    .from(serviceAreaAssignment)
    .where(and(assignmentReach(principal), where))

/**
 * The areas the caller reads: the office's projects' (`inProjects`), or, for
 * a provider's account, the areas its own assignments name — through
 * `exists`, so an area the provider held once is read and an area nobody has
 * assigned is still the office's to see.
 */
const readable = (tx: Tx, principal: Principal) =>
  and(
    eq(serviceArea.companyId, principal.companyId),
    providerIdOf(principal) === null
      ? inProjects(serviceArea.projectId, principal)
      : exists(reachableAssignmentsOf(tx, principal, eq(serviceAreaAssignment.serviceAreaId, serviceArea.id))),
  )

/** The areas the caller writes: the office's projects' and no other, since the award is the company's to make and to move. */
const writable = (principal: Principal) => and(eq(serviceArea.companyId, principal.companyId), inProjects(serviceArea.projectId, principal))

/** The same for an assignment's writes. */
const writableAssignment = (principal: Principal) => and(eq(serviceAreaAssignment.companyId, principal.companyId), inProjects(serviceAreaAssignment.projectId, principal))

/** One area by id under a scope; undefined when it is not there. */
async function findArea(tx: Tx, where: SQL | undefined, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(serviceArea)
    .where(and(where, eq(serviceArea.id, id)))
    .limit(1)
  return row
}

/** One assignment by id under a scope; undefined when it is not there. */
async function findAssignment(tx: Tx, where: SQL | undefined, id: string): Promise<AssignmentRow | undefined> {
  const [row] = await tx
    .select(assignmentColumns)
    .from(serviceAreaAssignment)
    .where(and(where, eq(serviceAreaAssignment.id, id)))
    .limit(1)
  return row
}

/** The planning-area set's columns, what reading it needs. */
const PLANNING_AREAS: IdSetColumns = { table: serviceAreaPlanningArea, parentId: serviceAreaPlanningArea.serviceAreaId, entryId: serviceAreaPlanningArea.planningAreaId }

/** The fraction set's columns. */
const WASTE_FRACTIONS: IdSetColumns = { table: serviceAreaWasteFraction, parentId: serviceAreaWasteFraction.serviceAreaId, entryId: serviceAreaWasteFraction.wasteFractionId }

/** The planning areas an award covers, rows of one project: the plural check is project-scoped and the membership row carries the project, so the descriptor is built for the project the area is in; `at` is the field the body carried the ids in (`planningAreaIds` on the create, `ids` on the PUT). */
const planningAreasOf = (projectId: string, at = "planningAreaIds"): IdSet<typeof serviceAreaPlanningArea> => ({
  ...PLANNING_AREAS,
  table: serviceAreaPlanningArea,
  rowOf: (planningAreaId, owner) => ({ id: newId(), companyId: owner.companyId, projectId, serviceAreaId: owner.id, planningAreaId }),
  require: async (tx, companyId, ids) =>
    await eachPresent(
      tx,
      planningArea,
      planningArea.id,
      companyId,
      ids.map((id, index) => ({ id, path: `${at}.${index}` })),
      (entry) => requirePlanningArea(tx, { companyId, projectId }, entry.id, entry.path),
      eq(planningArea.projectId, projectId),
    ),
})

/** The waste fractions an award is for, the company's rows; the descriptor carries the project only to write it onto the membership row, and `at` the field the body carried the ids in. */
const wasteFractionsOf = (projectId: string, at = "wasteFractionIds"): IdSet<typeof serviceAreaWasteFraction> => ({
  ...WASTE_FRACTIONS,
  table: serviceAreaWasteFraction,
  rowOf: (wasteFractionId, owner) => ({ id: newId(), companyId: owner.companyId, projectId, serviceAreaId: owner.id, wasteFractionId }),
  require: requireEachOf(wasteFraction, at, requireWasteFraction),
})

/** The two sets of a whole page, each in one query, grouped by area. */
async function setsOf(tx: Tx, companyId: string, areaIds: readonly string[]): Promise<Map<string, Sets>> {
  const [areas, fractions] = await Promise.all([idsOf(tx, PLANNING_AREAS, companyId, areaIds), idsOf(tx, WASTE_FRACTIONS, companyId, areaIds)])
  return new Map(areaIds.map((id) => [id, { planningAreaIds: areas.get(id) ?? [], wasteFractionIds: fractions.get(id) ?? [] }]))
}

/** One area's sets, read the way a page reads them. */
async function setsFor(tx: Tx, companyId: string, areaId: string): Promise<Sets> {
  return (await setsOf(tx, companyId, [areaId])).get(areaId) ?? { planningAreaIds: [], wasteFractionIds: [] }
}

/** One area's assignments the caller reaches, earliest first — by start, then by id for two that start together. */
async function assignmentsFor(tx: Tx, principal: Principal, areaId: string): Promise<ServiceAreaAssignment[]> {
  const rows = await tx
    .select(assignmentColumns)
    .from(serviceAreaAssignment)
    .where(and(assignmentReach(principal), eq(serviceAreaAssignment.serviceAreaId, areaId)))
    .orderBy(asc(serviceAreaAssignment.validFrom), asc(serviceAreaAssignment.id))
  return rows.map(assignmentOf)
}

/** An area's period as a `daterange`, half-open like the exclusion constraints', against a period given as two days. */
const overlapping = (columns: { validFrom: PgColumn; validTo: PgColumn }, period: Period): SQL =>
  sql`daterange(${columns.validFrom}, ${columns.validTo}, '[)') && daterange(${period.validFrom}::date, ${period.validTo}::date, '[)')`

/**
 * The one-award rule: none of `planningAreaIds` is in another area of the
 * project over a period overlapping this one. One statement finds every
 * membership in the way — the planning area's code and the other area's, for
 * the sentence — and takes the other areas' row locks in id order (`for
 * update of` the area, which Postgres wants named without its schema, hence
 * the alias), the caller having taken this area's first, so two areas
 * claiming each other's planning area take turns and neither passes on a
 * state the other has not written. The refusal is a 409 at the entry, the
 * first in body order, with the sentence as `detail` too.
 */
async function requireAwardedOnce(tx: Tx, area: { companyId: string; projectId: string; id: string | null }, planningAreaIds: readonly string[], period: Period, at = "planningAreaIds"): Promise<void> {
  if (planningAreaIds.length === 0) return
  const held = alias(serviceArea, "held")
  const conflicts = await tx
    .select({ planningAreaId: serviceAreaPlanningArea.planningAreaId, planningAreaCode: planningArea.code, serviceAreaCode: held.code })
    .from(serviceAreaPlanningArea)
    .innerJoin(held, and(eq(held.companyId, serviceAreaPlanningArea.companyId), eq(held.id, serviceAreaPlanningArea.serviceAreaId)))
    .innerJoin(planningArea, and(eq(planningArea.companyId, serviceAreaPlanningArea.companyId), eq(planningArea.id, serviceAreaPlanningArea.planningAreaId)))
    .where(
      and(
        eq(serviceAreaPlanningArea.companyId, area.companyId),
        eq(held.projectId, area.projectId),
        area.id === null ? undefined : ne(held.id, area.id),
        inArray(serviceAreaPlanningArea.planningAreaId, [...planningAreaIds]),
        overlapping(held, period),
      ),
    )
    .orderBy(asc(held.id))
    .for("update", { of: held })
  // The first entry of the body that is in the way, so the path names what the caller wrote.
  for (const [index, id] of planningAreaIds.entries()) {
    const conflict = conflicts.find((found) => found.planningAreaId === id)
    if (conflict === undefined) continue
    const detail = awardedElsewhere(conflict.planningAreaCode, conflict.serviceAreaCode)
    throw problem(409, { detail, errors: [{ path: `${at}.${index}`, message: detail }] })
  }
}

/** Whether a period moved reaches days the old one did not: the rule the one-award check is re-run for on a patch. */
const widened = (before: Period, after: Period): boolean =>
  after.validFrom < before.validFrom || (before.validTo !== null && (after.validTo === null || after.validTo > before.validTo))

/** The `where` of the assignments an area's move would strand, for `refuseStranded`. */
const strandedAssignmentsOf = (area: { companyId: string; id: string }, period: Period) =>
  and(eq(serviceAreaAssignment.companyId, area.companyId), eq(serviceAreaAssignment.serviceAreaId, area.id), notWithin(serviceAreaAssignment, period))

/** The `where` of the prices an assignment's move would strand. */
const strandedPricesOf = (assignment: { companyId: string; id: string }, period: Period) =>
  and(eq(serviceProviderPrice.companyId, assignment.companyId), eq(serviceProviderPrice.serviceAreaAssignmentId, assignment.id), notWithin(serviceProviderPrice, period))

/** The assignments naming a provider on a day, for the areas list's `serviceProviderId` filter, which requires `validOn`. */
const heldBy = (tx: Tx, principal: Principal, serviceProviderId: string, day: string) =>
  exists(
    reachableAssignmentsOf(
      tx,
      principal,
      and(eq(serviceAreaAssignment.serviceAreaId, serviceArea.id), eq(serviceAreaAssignment.serviceProviderId, serviceProviderId), validOn(serviceAreaAssignment, day)),
    ),
  )

/** The areas naming a planning area: one `exists` over the set. */
const covering = (companyId: string, planningAreaId: string) =>
  exists(
    sql`(select 1 from ${serviceAreaPlanningArea} where ${serviceAreaPlanningArea.companyId} = ${companyId} and ${serviceAreaPlanningArea.serviceAreaId} = ${serviceArea.id} and ${serviceAreaPlanningArea.planningAreaId} = ${planningAreaId})`,
  )

/** Writes one assignment of an area: the provider this company's, the period inside the area's, the area held by one provider at a time. `at` is where the body carried it — `assignment.` on the area's create. */
async function writeAssignment(tx: Tx, area: Parent & Period, values: { serviceProviderId: string; notes?: string | null } & Period, at = ""): Promise<AssignmentRow> {
  await requireServiceProvider(tx, area.companyId, values.serviceProviderId, `${at}serviceProviderId`)
  requireWithin(area, values, OUTSIDE_SERVICE_AREA, at)
  const [row] = await refuseOverlap({ [ASSIGNMENT_RUNNING]: ASSIGNMENT_RUNNING_SENTENCE }, () =>
    tx
      .insert(serviceAreaAssignment)
      .values({
        id: newId(),
        companyId: area.companyId,
        projectId: area.projectId,
        serviceAreaId: area.id,
        serviceProviderId: values.serviceProviderId,
        notes: values.notes ?? null,
        validFrom: values.validFrom,
        validTo: values.validTo,
      })
      .returning(assignmentColumns),
  )
  return row
}

export function serviceAreaRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/service-areas",
      describeRoute({
        operationId: "listServiceAreas",
        summary: "The service areas the caller reaches",
        description:
          "One page of service areas, oldest first (ids are time-ordered), each with its planning areas and waste fractions by id. An office account reads the areas of the projects it works in; a service provider's account, which works in no project, reads the areas its own assignments name and no other. `projectId` narrows it to one of the caller's projects; naming another is refused. `validOn` asks for the areas in force on that day, `validFrom` inclusive and `validTo` exclusive, which is how Upcoming, Active and Expired are asked for; `planningAreaId` for the areas covering that planning area; `serviceProviderId` for the areas that provider holds on `validOn`, which it requires, since a provider holds an area through an assignment valid on a day. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of service areas, each with its two sets.", ServiceAreaPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, `validOn` is not a calendar day, `serviceProviderId` was given without `validOn`, or `projectId` is not a project this account works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `service-providers.service-areas`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", ServiceAreaListQuery),
      async (c) => {
        const { limit, cursor, projectId, validOn: day, planningAreaId, serviceProviderId } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await tx
          .select(columns)
          .from(serviceArea)
          .where(
            and(
              readable(tx, principal),
              projectId === undefined ? undefined : eq(serviceArea.projectId, projectId),
              day === undefined ? undefined : validOn(serviceArea, day),
              planningAreaId === undefined ? undefined : covering(principal.companyId, planningAreaId),
              // The contracts hold `serviceProviderId` to come with `validOn`.
              serviceProviderId === undefined || day === undefined ? undefined : heldBy(tx, principal, serviceProviderId, day),
              after === undefined ? undefined : gt(serviceArea.id, after),
            ),
          )
          .orderBy(asc(serviceArea.id))
          .limit(fetchLimit(limit))
        // Paged first, so the row that only proves there is a next page is
        // not one of the areas whose sets are loaded.
        const { items, nextCursor } = pageOf(rows, limit)
        const held = await setsOf(tx, principal.companyId, items.map((row) => row.id))
        return c.json({ items: items.map((row) => areaOf(row, held.get(row.id) ?? { planningAreaIds: [], wasteFractionIds: [] })), nextCursor })
      },
    )
    .post(
      "/service-areas",
      describeRoute({
        operationId: "createServiceArea",
        summary: "Make a service area",
        description:
          "Makes an award in one project, which must be a project the caller works in. The code is what the contract spells (`CA-Ø-2`) and is set once; one area of a code is in force at a time, so a period overlapping another area of the code is refused (409). `boundaryText` is the contract's own boundary text, the authoritative legal boundary; `planningAreaIds` is the operational geography the award covers, each a planning area of the project (400 at `planningAreaIds.N` otherwise) and each named once, and `wasteFractionIds` its scope, each a waste fraction of this company (400 at `wasteFractionIds.N`); either may be empty, and an area covering no planning area reaches no route. A planning area is awarded once at a time: one that another area of the project names over an overlapping period is refused (409 at the entry, `Planning area OP-CEN-01 is already in service area CA-Ø-2 over part of that period`). `assignment`, when given, is the first assignment — the provider this company's (400 on `assignment.serviceProviderId`), its period the area's when absent and inside the area's otherwise (400 on `assignment.validFrom` or `assignment.validTo`) — written in the same transaction, so a refused provider takes the area with it, and answered beside the area, or null when none was made; an area may also be made first and assigned through `POST /service-areas/{id}/assignments`. The server mints the ids.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The service area as it was written, its two sets by id, and the first assignment beside it — null when the body made none.", ServiceAreaCreated),
          400: describeProblem(
            "The body is missing a field, names a member the server owns, names a project this account does not work in, ends on or before the day it starts, names the same planning area or fraction twice, names a planning area that is not the project's or a fraction that is not this company's, or gives a first assignment naming a provider that is not this company's or a period outside the area's.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `service-providers.service-areas`."),
          409: describeProblem("A service area of this code is already in force over part of that period, or a planning area named is already in another service area over part of it."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", ServiceAreaCreate),
      async (c) => {
        const { planningAreaIds, wasteFractionIds, assignment, ...values } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, values.projectId)
        const period = periodOf(values)
        const planningAreas = planningAreasOf(values.projectId)
        const fractions = wasteFractionsOf(values.projectId)
        await planningAreas.require(tx, principal.companyId, planningAreaIds)
        await fractions.require(tx, principal.companyId, wasteFractionIds)
        // The first assignment's own 400s — the provider, the period — before any 409, so the caller hears what to fix in the body first.
        const first =
          assignment === undefined
            ? undefined
            : { serviceProviderId: assignment.serviceProviderId, validFrom: assignment.validFrom ?? period.validFrom, validTo: assignment.validTo === undefined ? period.validTo : assignment.validTo }
        if (first !== undefined) {
          await requireServiceProvider(tx, principal.companyId, first.serviceProviderId, "assignment.serviceProviderId")
          requireWithin(period, first, OUTSIDE_SERVICE_AREA, "assignment.")
        }

        // Every 400 above, every 409 below: the one-award rule, then the code's period.
        await requireAwardedOnce(tx, { companyId: principal.companyId, projectId: values.projectId, id: null }, planningAreaIds, period)
        const [row] = await refuseOverlap({ [AREA_RUNNING]: AREA_RUNNING_SENTENCE }, () =>
          tx
            .insert(serviceArea)
            .values({ ...values, id: newId(), companyId: principal.companyId })
            .returning(columns),
        )
        const owner = { companyId: principal.companyId, id: row.id }
        await writeIds(tx, planningAreas, owner, planningAreaIds)
        await writeIds(tx, fractions, owner, wasteFractionIds)
        const parent: Parent & Period = { companyId: principal.companyId, projectId: row.projectId, id: row.id, validFrom: row.validFrom, validTo: row.validTo }
        const written = first === undefined ? null : await writeAssignment(tx, parent, first, "assignment.")
        // The sets just written are known — held to their keys, each id once — so they are answered in read order and not read back.
        const answer: ServiceAreaCreated = { ...areaOf(row, { planningAreaIds: asRead(planningAreaIds), wasteFractionIds: asRead(wasteFractionIds) }), assignment: written === null ? null : assignmentOf(written) }
        return created(c, "/service-areas", answer)
      },
    )
    .get(
      "/service-areas/:id",
      describeRoute({
        operationId: "getServiceArea",
        summary: "One service area",
        description:
          "One service area the caller reaches, with its planning areas and waste fractions by id and its assignments, earliest first. An office account reaches the areas of the projects it works in; a service provider's account the areas its own assignments name, and reads those assignments alone. An area outside that is an area that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The service area, its two sets and its assignments.", ServiceAreaDetail),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `service-providers.service-areas`."),
          404: describeProblem("No service area with that id this account reaches."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findArea(tx, readable(tx, principal), id)
        if (row === undefined) throw noSuchArea(id)
        const answer: ServiceAreaDetail = { ...areaOf(row, await setsFor(tx, principal.companyId, row.id)), assignments: await assignmentsFor(tx, principal, row.id) }
        return c.json(answer)
      },
    )
    .patch(
      "/service-areas/:id",
      describeRoute({
        operationId: "patchServiceArea",
        summary: "Amend a service area",
        description:
          "Changes the name, the boundary text, the notes or the period of one service area of a project the caller works in; every field is optional and at least one must be given. The code does not change — it is what the contract spells — and the project is not patchable, since a record does not move between projects; the two sets are `PUT /service-areas/{id}/planning-areas` and `PUT /service-areas/{id}/waste-fractions`. Moving the period is held under the area's row lock: the end still comes after the start, which a body naming one bound cannot see by itself; the new period still holds every assignment of the area — a shortening that would leave one outside is refused (409) counting them, and the assignments have to be ended first; a widening re-runs the one-award rule over the area's planning areas (409 at the entry); and the period may not overlap another area of the code (409). A service provider's account changes nothing here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The service area as it now stands, with its two sets.", ServiceArea),
          400: describeProblem("The path does not hold an id, or the patch is empty, names a field the caller does not own (the code, the project and the sets included), or ends on or before the day it starts."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `service-providers.service-areas`."),
          404: describeProblem("No service area with that id in the projects this account works in."),
          409: describeProblem("Assignments of the area would fall outside the new period, a planning area of the area is in another area over the widened period, or another area of the code is in force over part of it."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", ServiceAreaPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        // The row this patch counts assignments against, locked before it is
        // read: a shortening and an assignment being added are the two halves
        // of one rule, and they serialise here (routes/shared.ts).
        await lockRow(tx, serviceArea, { companyId: principal.companyId, id })
        const current = await findArea(tx, writable(principal), id)
        if (current === undefined) throw noSuchArea(id)
        const period = patch.validFrom !== undefined || patch.validTo !== undefined ? periodAfter(current, patch) : undefined
        if (period !== undefined) requireOrdered(period)

        // Every 400 above, every 409 below.
        if (period !== undefined) {
          await refuseStranded(tx, serviceAreaAssignment, strandedAssignmentsOf({ companyId: principal.companyId, id }, period), strandedAssignments)
          if (widened(current, period)) {
            const held = await setsFor(tx, principal.companyId, id)
            await requireAwardedOnce(tx, { companyId: principal.companyId, projectId: current.projectId, id }, held.planningAreaIds, period)
          }
        }
        const [row] = await refuseOverlap({ [AREA_RUNNING]: AREA_RUNNING_SENTENCE }, () =>
          tx
            .update(serviceArea)
            .set(patch)
            .where(and(writable(principal), eq(serviceArea.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchArea(id)
        return c.json(areaOf(row, await setsFor(tx, principal.companyId, row.id)))
      },
    )
    .put(
      "/service-areas/:id/planning-areas",
      describeRoute({
        operationId: "putServiceAreaPlanningAreas",
        summary: "Replace the planning areas a service area covers",
        description:
          "Replaces the whole set with the one in the body: a planning area the body leaves out is not covered afterwards, and an empty list is an award that reaches no route. Every id is a planning area of the area's project (400 at `ids.N` otherwise), each named once (400 on `ids`), and none is in another service area of the project over a period overlapping this area's (409 at the entry, the one-award rule, held under both areas' locks). The area's `updatedAt` moves, since the set is part of the area on the wire. A service provider's account changes nothing here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The service area with the planning areas it now covers.", ServiceArea),
          400: describeProblem("The path does not hold an id, or the body is missing `ids`, names a member it does not own, names the same planning area twice, or names a planning area that is not the area's project's."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `service-providers.service-areas`."),
          404: describeProblem("No service area with that id in the projects this account works in."),
          409: describeProblem("A planning area named is already in another service area over part of the area's period."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", ServiceAreaPlanningAreasSet),
      async (c) => {
        const { id } = c.req.valid("param")
        const { ids } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        // The area's lock, then the area, then the ids proved, then the
        // one-award rule over them, then the replacement: routes/id-sets.ts's
        // steps spelled out, since the rule runs between the proof and the
        // write and takes the other areas' locks (routes/shared.ts).
        await lockRow(tx, serviceArea, { companyId: principal.companyId, id })
        const current = await findArea(tx, writable(principal), id)
        if (current === undefined) throw noSuchArea(id)
        const set = planningAreasOf(current.projectId, "ids")
        await set.require(tx, principal.companyId, ids)
        await requireAwardedOnce(tx, { companyId: principal.companyId, projectId: current.projectId, id }, ids, current, "ids")
        const [row] = await tx
          .update(serviceArea)
          .set(stamp())
          .where(and(writable(principal), eq(serviceArea.id, id)))
          .returning(columns)
        if (row === undefined) throw noSuchArea(id)
        await tx.delete(serviceAreaPlanningArea).where(and(eq(serviceAreaPlanningArea.companyId, principal.companyId), eq(serviceAreaPlanningArea.serviceAreaId, id)))
        await writeIds(tx, set, { companyId: principal.companyId, id }, ids)
        const fractions = await idsFor(tx, WASTE_FRACTIONS, principal.companyId, row.id)
        return c.json(areaOf(row, { planningAreaIds: asRead(ids), wasteFractionIds: fractions }))
      },
    )
    .put(
      "/service-areas/:id/waste-fractions",
      describeRoute({
        operationId: "putServiceAreaWasteFractions",
        summary: "Replace the waste fractions a service area is awarded for",
        description:
          "Replaces the whole set with the one in the body: a fraction the body leaves out is not in the award's scope afterwards, and an empty list is an award with no fraction named yet. Every id is a waste fraction of this company (400 at `ids.N` otherwise), each named once (400 on `ids`). The area's `updatedAt` moves, since the set is part of the area on the wire. A service provider's account changes nothing here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The service area with the fractions it is now awarded for.", ServiceArea),
          400: describeProblem("The path does not hold an id, or the body is missing `ids`, names a member it does not own, names the same fraction twice, or names a waste fraction that is not this company's."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `service-providers.service-areas`."),
          404: describeProblem("No service area with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", ServiceAreaWasteFractionsSet),
      async (c) => {
        const { id } = c.req.valid("param")
        const { ids } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        // The area is read for its project, which the membership rows carry; the replacement's own stamping update answers the 404 again and takes the lock.
        const current = await findArea(tx, writable(principal), id)
        if (current === undefined) throw noSuchArea(id)
        const row = await replaceIdSet(tx, wasteFractionsOf(current.projectId, "ids"), principal.companyId, ids, (stamped) =>
          tx
            .update(serviceArea)
            .set(stamped)
            .where(and(writable(principal), eq(serviceArea.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchArea(id)
        const areas = await idsFor(tx, PLANNING_AREAS, principal.companyId, row.id)
        return c.json(areaOf(row, { planningAreaIds: areas, wasteFractionIds: asRead(ids) }))
      },
    )
    .get(
      "/service-areas/:id/assignments",
      describeRoute({
        operationId: "listServiceAreaAssignmentsOfArea",
        summary: "One service area's assignments",
        description:
          "The assignments of one service area the caller reaches, earliest first: who held the area when, as a bare list, since an area has a handful. An office account reads every assignment of an area of its projects; a service provider's account reads its own on an area they name. An area outside the caller's reach is an area that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The area's assignments, earliest first.", Assignments),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `service-providers.service-areas`."),
          404: describeProblem("No service area with that id this account reaches."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        if ((await findArea(tx, readable(tx, principal), id)) === undefined) throw noSuchArea(id)
        return c.json(await assignmentsFor(tx, principal, id))
      },
    )
    .post(
      "/service-areas/:id/assignments",
      describeRoute({
        operationId: "createServiceAreaAssignment",
        summary: "Assign a service area to a provider",
        description:
          "Writes one assignment of the area in the path, which must be an area of a project the caller works in: the provider, this company's (400 on `serviceProviderId`), and the period it holds the area over, half-open and inside the area's (400 on the bound outside). One provider holds an area at a time, so a period overlapping the area's other assignment is refused (409, `This service area is already assigned over part of that period; end the assignment first`): a transfer is the old assignment ended on the day through its patch and the new one added from that day, which preserves the area and the earlier award. The server mints the id; the assignment is read at `/service-area-assignments/{id}`.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The assignment as it was written.", ServiceAreaAssignment),
          400: describeProblem("The path does not hold an id, or the body is missing a field, names a member the server owns, ends on or before the day it starts, puts a bound outside the area's period, or names a service provider that is not this company's."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `service-providers.service-areas`."),
          404: describeProblem("No service area with that id in the projects this account works in."),
          409: describeProblem("The service area is already assigned over part of that period."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("param", IdParam),
      validate("json", ServiceAreaAssignmentCreate),
      async (c) => {
        const { id } = c.req.valid("param")
        const values = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        // The area's lock, then the area: an assignment being added and the
        // area being shortened are the two halves of one rule (routes/periods.ts).
        await lockRow(tx, serviceArea, { companyId: principal.companyId, id })
        const area = await findArea(tx, writable(principal), id)
        if (area === undefined) throw noSuchArea(id)
        const parent: Parent & Period = { companyId: principal.companyId, projectId: area.projectId, id: area.id, validFrom: area.validFrom, validTo: area.validTo }
        const row = await writeAssignment(tx, parent, { ...values, ...periodOf(values) })
        return created(c, "/service-area-assignments", assignmentOf(row))
      },
    )
    .get(
      "/service-area-assignments",
      describeRoute({
        operationId: "listServiceAreaAssignments",
        summary: "The service area assignments the caller reaches",
        description:
          "One page of assignments, oldest first (ids are time-ordered). An office account reads the assignments of the areas of the projects it works in; a service provider's account, which works in no project, reads the assignments naming its own provider and no other — the first office rows a provider's account reaches at all. `projectId` narrows it to one of the caller's projects; naming another is refused. `serviceAreaId` narrows it to one area's, `serviceProviderId` to one provider's, and `validOn` to the assignments in force on that day, `validFrom` inclusive and `validTo` exclusive. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of assignments.", AssignmentPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, `validOn` is not a calendar day, a filter is not an id, or `projectId` is not a project this account works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `service-providers.service-areas`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", ServiceAreaAssignmentListQuery),
      async (c) => {
        const { limit, cursor, projectId, serviceAreaId, serviceProviderId, validOn: day } = c.req.valid("query")
        const after = afterCursor(cursor)
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await c
          .get("tx")
          .select(assignmentColumns)
          .from(serviceAreaAssignment)
          .where(
            and(
              assignmentReach(principal),
              projectId === undefined ? undefined : eq(serviceAreaAssignment.projectId, projectId),
              serviceAreaId === undefined ? undefined : eq(serviceAreaAssignment.serviceAreaId, serviceAreaId),
              serviceProviderId === undefined ? undefined : eq(serviceAreaAssignment.serviceProviderId, serviceProviderId),
              day === undefined ? undefined : validOn(serviceAreaAssignment, day),
              after === undefined ? undefined : gt(serviceAreaAssignment.id, after),
            ),
          )
          .orderBy(asc(serviceAreaAssignment.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(assignmentOf), limit))
      },
    )
    .get(
      "/service-area-assignments/:id",
      describeRoute({
        operationId: "getServiceAreaAssignment",
        summary: "One service area assignment",
        description:
          "One assignment the caller reaches: of an area of a project an office account works in, or naming a service provider account's own provider. An assignment outside that is an assignment that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The assignment.", ServiceAreaAssignment),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `service-providers.service-areas`."),
          404: describeProblem("No service area assignment with that id this account reaches."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const principal = c.get("principal")
        const row = await findAssignment(c.get("tx"), assignmentReach(principal), id)
        if (row === undefined) throw noSuchAssignment(id)
        return c.json(assignmentOf(row))
      },
    )
    .patch(
      "/service-area-assignments/:id",
      describeRoute({
        operationId: "patchServiceAreaAssignment",
        summary: "Amend a service area assignment",
        description:
          "Changes the notes or the end of one assignment of an area of a project the caller works in; every field is optional and at least one must be given. The provider and the area do not change — a transfer is a new assignment, this one ended on the day — and the start does not either. Moving the end is held under the area's lock and then the assignment's: the end still comes after the start, the assignment still lies inside the area's period (400 on `validTo`), the new period still holds every service provider price under the assignment — a shortening that would leave one outside is refused (409) counting them, and the prices have to be ended first; a settlement over the assignment is not counted — and the assignment still overlaps no other of the area (409): a reopened or lengthened assignment meeting the next holder's is refused there. A service provider's account changes nothing here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The assignment as it now stands.", ServiceAreaAssignment),
          400: describeProblem("The path does not hold an id, or the patch is empty, names a field the caller does not own (the provider, the area, the start and the project included), ends on or before the day it starts, or puts the end outside the area's period."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `service-providers.service-areas`."),
          404: describeProblem("No service area assignment with that id in the projects this account works in."),
          409: describeProblem("Service provider prices under the assignment would fall outside the new period, or the area's other assignment is in force over part of it."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", ServiceAreaAssignmentPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        // The assignment is read once to learn its area, then both locks are
        // taken from the top down — the area before the assignment, as the
        // area's patch and the assignment's create take them — and the
        // assignment is read again under them, so an area shortened while
        // this waited is what the end is held inside (routes/periods.ts).
        const named = await findAssignment(tx, writableAssignment(principal), id)
        if (named === undefined) throw noSuchAssignment(id)
        await lockRow(tx, serviceArea, { companyId: principal.companyId, id: named.serviceAreaId })
        await lockRow(tx, serviceAreaAssignment, { companyId: principal.companyId, id })
        const current = await findAssignment(tx, writableAssignment(principal), id)
        if (current === undefined) throw noSuchAssignment(id)
        const period = patch.validTo === undefined ? undefined : periodAfter(current, patch)
        if (period !== undefined) {
          const area = await findArea(tx, writable(principal), current.serviceAreaId)
          if (area === undefined) throw noSuchAssignment(id)
          requireWithin(area, period, OUTSIDE_SERVICE_AREA)
          // Every 400 above, every 409 below.
          await refuseStranded(tx, serviceProviderPrice, strandedPricesOf({ companyId: principal.companyId, id }, period), strandedPrices)
        }
        const [row] = await refuseOverlap({ [ASSIGNMENT_RUNNING]: ASSIGNMENT_RUNNING_SENTENCE }, () =>
          tx
            .update(serviceAreaAssignment)
            .set(patch)
            .where(and(writableAssignment(principal), eq(serviceAreaAssignment.id, id)))
            .returning(assignmentColumns),
        )
        if (row === undefined) throw noSuchAssignment(id)
        return c.json(assignmentOf(row))
      },
    )
}
