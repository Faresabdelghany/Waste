// Where work happens (Issue #97, ADR-0002, ADR-0005): the Planning Area and
// its boundary versions. `GET /planning-areas` lists the areas, `POST
// /planning-areas` registers one, `GET`/`PATCH /planning-areas/:id` read and
// amend one; `GET`/`POST /planning-areas/:id/boundaries` read and add an
// area's versions, `GET /planning-area-boundaries` reads the versions across
// a project's areas — the Layers control's read — and `GET`/`PATCH
// /planning-area-boundaries/:id` read and amend one version. No delete
// anywhere: an area stops being in force when its last boundary ends, which
// is a `validTo`, and an area a scheme has named stays named.
//
// Two resources, because a Route Scheme names the area and not one drawing of
// it: a scheme that named a boundary row would break the day a new version
// started. The area is the identity — the stable `code` a person quotes, a
// name, a purpose — and carries no status: "in force on a day" is having a
// boundary valid that day, and `?validOn=` on the two boundary lists is how
// that is asked (@waste/db/query/valid-on). The code is set once, like a
// waste fraction's key, so the patch schema does not carry it.
//
// The boundary is the first polygon this system stores rather than derives.
// It goes in and comes back as GeoJSON through the column type
// (@waste/db/schema/geometry), the same way a property's point does. Two
// rules hold it, and they are two authorities' rules. The ring and the globe
// are the contracts': a closed ring of four or more positions, three
// distinct, holes allowed, no altitude, every ordinate on the globe — all
// refused by the validator before the database is asked. Validity is
// PostGIS's: whether those rings make a polygon at all, which `st_isvalid`
// decides — a ring that crosses itself, a hole outside its shell, nested or
// duplicate rings, a hole touching the shell along a line — and no shape rule
// can restate, so it is the one check here only the database runs. It refuses
// with 23514 naming `planning_area_boundary_boundary_valid`, and
// `refuseCheck` (routes/shared.ts) turns that into the 400 on `boundary` a
// schema would have answered, with the one sentence the constraint can stand
// behind, "Not a valid polygon": PostGIS says why in its own words and the
// API does not guess. The database's exclusion constraint holds the other rule —
// one boundary of an area in force at a time, a new version starting when the
// old ends — and `refuseOverlap` gives it its sentence. Overlap between two
// areas of one project is allowed and is a read, not a constraint.
//
// The rest is the shape every project-scoped family has: each statement
// carries the tenant and `inProjects` (auth/projects.ts), a create names a
// project the caller works in and a record never moves between projects. A
// boundary names neither its area nor its project — the path says the first
// and the area says the second. Both lists page by id like every list in
// this API (pagination.ts: the cursor is a cursor over `id`), which for a
// version 7 id is the order the versions were written in; a client that wants
// the timeline of an area sorts its handful of versions by `validFrom`, and
// `validOn` is how the one in force is asked for.
//
// The grant is `configure.areas` throughout, boundaries included: a boundary
// is a version of an area and not a surface of its own.
import type { FlatPolygon } from "@waste/contracts/geojson"
import { Page } from "@waste/contracts/pagination"
import type { PlanningAreaPurpose } from "@waste/contracts/planning"
import {
  PlanningArea,
  PlanningAreaBoundary,
  PlanningAreaBoundaryCreate,
  PlanningAreaBoundaryListQuery,
  PlanningAreaBoundaryPatch,
  PlanningAreaBoundaryVersionsQuery,
  PlanningAreaCreate,
  PlanningAreaCreated,
  PlanningAreaListQuery,
  PlanningAreaPatch,
} from "@waste/contracts/planning-areas"
import type { Tx } from "@waste/db/client"
import { validOn } from "@waste/db/query/valid-on"
import { planningArea, planningAreaBoundary } from "@waste/db/schema/planning-areas"
import { and, asc, eq, gt } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { periodAfter, requireOrdered } from "./periods"
import { describeJson, IdParam, refuseCheck, refuseDuplicate, refuseOverlap, stampsOf, type CheckRefusal } from "./shared"

const MODULE = "configure.areas"
const PlanningAreaPage = Page(PlanningArea)
const PlanningAreaBoundaryPage = Page(PlanningAreaBoundary)

const columns = {
  id: planningArea.id,
  projectId: planningArea.projectId,
  code: planningArea.code,
  name: planningArea.name,
  purpose: planningArea.purpose,
  createdAt: planningArea.createdAt,
  updatedAt: planningArea.updatedAt,
}

type Row = Pick<typeof planningArea.$inferSelect, keyof typeof columns>

/** The row on the wire. `purpose` is text with a CHECK in the database and an enum here, both read off the one vocabulary tuple. */
function areaOf(row: Row): PlanningArea {
  return {
    id: row.id,
    projectId: row.projectId,
    code: row.code,
    name: row.name,
    purpose: row.purpose as PlanningAreaPurpose,
    ...stampsOf(row),
  }
}

const boundaryColumns = {
  id: planningAreaBoundary.id,
  projectId: planningAreaBoundary.projectId,
  planningAreaId: planningAreaBoundary.planningAreaId,
  boundary: planningAreaBoundary.boundary,
  validFrom: planningAreaBoundary.validFrom,
  validTo: planningAreaBoundary.validTo,
  createdAt: planningAreaBoundary.createdAt,
  updatedAt: planningAreaBoundary.updatedAt,
}

type BoundaryRow = Pick<typeof planningAreaBoundary.$inferSelect, keyof typeof boundaryColumns>

/** The version on the wire; the polygon arrives as the GeoJSON the column type decoded. The column is `geometry(Polygon, 4326)`, flat — a third ordinate is refused on write — so what it holds is the contracts' `FlatPolygon` however the column's type spells the altitude as optional. */
function boundaryOf(row: BoundaryRow): PlanningAreaBoundary {
  return {
    id: row.id,
    projectId: row.projectId,
    planningAreaId: row.planningAreaId,
    boundary: row.boundary as FlatPolygon,
    validFrom: row.validFrom,
    validTo: row.validTo,
    ...stampsOf(row),
  }
}

/** `unique (company_id, project_id, code)`: a code is one area's inside a project, and free in the next. */
const CODE_TAKEN = "planning_area_project_id_code_key"
const codeTaken = (code: string) => `This project already has a planning area coded ${JSON.stringify(code)}`

/** `unique (company_id, project_id, name)`: the same for the name. */
const NAME_TAKEN = "planning_area_project_id_name_key"
const nameTaken = (name: string) => `This project already has a planning area called ${JSON.stringify(name)}`

/** `EXCLUDE USING gist (company_id, planning_area_id, daterange)`: one boundary of an area is in force at a time, and the next may follow it. */
const BOUNDARY_RUNNING = "planning_area_boundary_no_overlap"
const BOUNDARY_RUNNING_SENTENCE = "This planning area already has a boundary in force over that period; end it first"

/**
 * `CHECK (st_isvalid(boundary) and not st_isempty(boundary) and <WGS 84>)`: the
 * one check only the database can run on a body the validator let through. An
 * empty or an off-the-globe polygon never reaches it from here — the contracts
 * refuse the first by shape and the second by ordinate — so what it refuses on
 * this route is a polygon PostGIS calls invalid: a ring that crosses itself, a
 * hole outside its shell, nested or duplicate rings, a hole touching the shell
 * along a line. One constraint, one sentence, and a generic one, since the
 * constraint cannot say which of those it was. `path` is where the body
 * carried the polygon: `boundary` on a version, `boundary.boundary` on an
 * area registered with its first version.
 */
const POLYGON_INVALID = "planning_area_boundary_boundary_valid"
const NOT_A_VALID_POLYGON = "Not a valid polygon"
const polygonInvalid = (path: string): Record<string, CheckRefusal> => ({
  [POLYGON_INVALID]: { path, message: NOT_A_VALID_POLYGON },
})

const noSuchArea = (id: string) => problem(404, { detail: `No planning area ${id} in the projects this account works in` })
const noSuchBoundary = (id: string) => problem(404, { detail: `No planning area boundary ${id} in the projects this account works in` })

/** The rows of this company, in the projects the caller works in: what every planning area statement is bounded by. */
const scope = (principal: Principal) => and(eq(planningArea.companyId, principal.companyId), inProjects(planningArea.projectId, principal))

/** The same for a boundary, which carries the project its area is in. */
const boundaryScope = (principal: Principal) =>
  and(eq(planningAreaBoundary.companyId, principal.companyId), inProjects(planningAreaBoundary.projectId, principal))

/** One area of this company by id, inside the caller's projects; undefined when it is neither. */
async function findArea(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(planningArea)
    .where(and(scope(principal), eq(planningArea.id, id)))
    .limit(1)
  return row
}

/** One boundary version of this company by id, inside the caller's projects; undefined when it is neither. */
async function findBoundary(tx: Tx, principal: Principal, id: string): Promise<BoundaryRow | undefined> {
  const [row] = await tx
    .select(boundaryColumns)
    .from(planningAreaBoundary)
    .where(and(boundaryScope(principal), eq(planningAreaBoundary.id, id)))
    .limit(1)
  return row
}

/**
 * Writes one version of an area, on the create that registers the area with
 * its first and on the route that adds one: the period may not overlap another
 * version of the area (409), and the polygon must be one PostGIS calls valid
 * (400 on the polygon, at the path the body carried it). The two doors nest
 * because either constraint may be the one that refuses, and each has its own
 * sentence.
 */
async function writeBoundary(
  tx: Tx,
  area: { companyId: string; projectId: string; id: string },
  values: PlanningAreaBoundaryCreate,
  path: string,
): Promise<BoundaryRow> {
  const [row] = await refuseCheck(polygonInvalid(path), () =>
    refuseOverlap({ [BOUNDARY_RUNNING]: BOUNDARY_RUNNING_SENTENCE }, () =>
      tx
        .insert(planningAreaBoundary)
        .values({ ...values, id: newId(), companyId: area.companyId, projectId: area.projectId, planningAreaId: area.id })
        .returning(boundaryColumns),
    ),
  )
  return row
}

export function planningAreaRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/planning-areas",
      describeRoute({
        operationId: "listPlanningAreas",
        summary: "The planning areas of the caller's projects",
        description:
          "One page of planning areas, oldest first (ids are time-ordered), from the projects the caller works in — an account that works in none, such as a service provider's, reads an empty page. `projectId` narrows it to one of those projects; naming another is refused. `purpose` narrows it to the areas registered for that purpose. An area carries no status: whether it is in force on a day is whether one of its boundaries is, which `GET /planning-area-boundaries?validOn=` answers. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of planning areas.", PlanningAreaPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, `purpose` is not one of the three, or `projectId` is not a project this account works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `configure.areas`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", PlanningAreaListQuery),
      async (c) => {
        const { limit, cursor, projectId, purpose } = c.req.valid("query")
        const after = afterCursor(cursor)
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await c
          .get("tx")
          .select(columns)
          .from(planningArea)
          .where(
            and(
              scope(principal),
              projectId === undefined ? undefined : eq(planningArea.projectId, projectId),
              purpose === undefined ? undefined : eq(planningArea.purpose, purpose),
              after === undefined ? undefined : gt(planningArea.id, after),
            ),
          )
          .orderBy(asc(planningArea.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(areaOf), limit))
      },
    )
    .post(
      "/planning-areas",
      describeRoute({
        operationId: "createPlanningArea",
        summary: "Register a planning area",
        description:
          "Registers a planning area in one project, which must be a project the caller works in. The code is the stable reference the rest of the system quotes (`OP-CEN-01`) and is set once; the code and the name are each unique inside the project. `boundary` is the first version, written in the same transaction and answered beside the area (null when none was drawn), so the form that draws an area is one request and learns both ids from it; an area may also be registered first and drawn later through `POST /planning-areas/{id}/boundaries`. Two rules hold the polygon: the ring and the globe are the contracts' — a closed ring of four or more positions with three distinct, holes allowed, no altitude, every ordinate on the globe — refused before the database sees it; whether those rings make a valid polygon is PostGIS's (`st_isvalid`: a ring that crosses itself, a hole outside its shell, rings that touch along a line), refused by the database and answered as a 400 on `boundary.boundary`, \"Not a valid polygon\". The server mints the ids.",
        security: BEARER_SECURITY,
        responses: {
          201: describeJson("The planning area as it was written, with the first boundary version beside it — null when the body drew none.", PlanningAreaCreated),
          400: describeProblem(
            "The body is missing a field, names a member the server owns, names a project this account does not work in, holds a polygon that is not a closed ring on the globe or that PostGIS calls invalid, or gives a first boundary that ends on or before the day it starts.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `configure.areas`."),
          409: describeProblem("The project already has a planning area with that code, or one with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", PlanningAreaCreate),
      async (c) => {
        const { boundary, ...values } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, values.projectId)
        const [row] = await refuseDuplicate({ [CODE_TAKEN]: codeTaken(values.code), [NAME_TAKEN]: nameTaken(values.name) }, () =>
          tx
            .insert(planningArea)
            .values({ ...values, id: newId(), companyId: principal.companyId })
            .returning(columns),
        )
        const version =
          boundary === undefined
            ? null
            : await writeBoundary(tx, { companyId: principal.companyId, projectId: row.projectId, id: row.id }, boundary, "boundary.boundary")
        const created: PlanningAreaCreated = { ...areaOf(row), boundary: version === null ? null : boundaryOf(version) }
        return c.json(created, 201)
      },
    )
    .get(
      "/planning-areas/:id",
      describeRoute({
        operationId: "getPlanningArea",
        summary: "One planning area",
        description:
          "One planning area of a project the caller works in. An area of another company, or of a project this account does not work in, is an area that does not exist here. Its boundary versions are `GET /planning-areas/{id}/boundaries`.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The planning area.", PlanningArea),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `configure.areas`."),
          404: describeProblem("No planning area with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findArea(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchArea(id)
        return c.json(areaOf(row))
      },
    )
    .patch(
      "/planning-areas/:id",
      describeRoute({
        operationId: "patchPlanningArea",
        summary: "Amend a planning area",
        description:
          "Changes the name or the purpose of one planning area of a project the caller works in; every field is optional and at least one must be given. The code does not change: it is the reference a scheme, a service area or a report quotes, and an area that needs another code is another area. The project is not patchable, since a record does not move between projects, and the boundaries are versions with routes of their own.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The planning area as it now stands.", PlanningArea),
          400: describeProblem("The path does not hold an id, or the patch is empty or names a field the caller does not own (the code, the project and the boundaries included)."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `configure.areas`."),
          404: describeProblem("No planning area with that id in the projects this account works in."),
          409: describeProblem("The project already has another planning area with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", PlanningAreaPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const principal = c.get("principal")
        const sentences: Record<string, string> = patch.name === undefined ? {} : { [NAME_TAKEN]: nameTaken(patch.name) }
        const [row] = await refuseDuplicate(sentences, () =>
          c
            .get("tx")
            .update(planningArea)
            .set(patch)
            .where(and(scope(principal), eq(planningArea.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchArea(id)
        return c.json(areaOf(row))
      },
    )
    .get(
      "/planning-areas/:id/boundaries",
      describeRoute({
        operationId: "listPlanningAreaBoundaries",
        summary: "One planning area's boundary versions",
        description:
          "One page of the area's boundary versions, oldest written first (ids are time-ordered; a client wanting the timeline sorts by `validFrom`). The path says the area, so the only filter is `validOn`: the version in force on that day, `validFrom` inclusive and `validTo` exclusive — at most one, since the versions of an area never overlap, and none on a day between two versions. An area of another company, or of a project this account does not work in, is an area that does not exist here. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of the area's boundary versions.", PlanningAreaBoundaryPage),
          400: describeProblem("The path does not hold an id, the page size is outside 1..200, the cursor is not one this API wrote, or `validOn` is not a calendar day."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `configure.areas`."),
          404: describeProblem("No planning area with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      validate("query", PlanningAreaBoundaryVersionsQuery),
      async (c) => {
        const { id } = c.req.valid("param")
        const { limit, cursor, validOn: day } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if ((await findArea(tx, principal, id)) === undefined) throw noSuchArea(id)
        const rows = await tx
          .select(boundaryColumns)
          .from(planningAreaBoundary)
          .where(
            and(
              boundaryScope(principal),
              eq(planningAreaBoundary.planningAreaId, id),
              day === undefined ? undefined : validOn(planningAreaBoundary, day),
              after === undefined ? undefined : gt(planningAreaBoundary.id, after),
            ),
          )
          .orderBy(asc(planningAreaBoundary.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(boundaryOf), limit))
      },
    )
    .post(
      "/planning-areas/:id/boundaries",
      describeRoute({
        operationId: "createPlanningAreaBoundary",
        summary: "Add a boundary version to a planning area",
        description:
          "Adds one version of the area's outline, in force over a half-open period: `validFrom` is the first day in force and `validTo` the first day out of it, absent meaning the version is still running. The area says the project, so the body names neither. One boundary of an area is in force at a time, so a period overlapping another version is refused (409) and a new version begins where the earlier one ends — end the earlier one first through `PATCH /planning-area-boundaries/{id}`. Two rules hold the polygon: the ring and the globe are the contracts' — a closed ring of four or more positions with three distinct, holes allowed, no altitude, every ordinate on the globe — refused before the database sees it; whether those rings make a valid polygon is PostGIS's (`st_isvalid`: a ring that crosses itself, a hole outside its shell, rings that touch along a line), refused by the database and answered as a 400 on `boundary`, \"Not a valid polygon\". The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeJson("The boundary version as it was written.", PlanningAreaBoundary),
          400: describeProblem(
            "The path does not hold an id, or the body is missing a field, names a member the server owns, ends on or before the day it starts, or holds a polygon that is not a closed ring on the globe or that PostGIS calls invalid.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `configure.areas`."),
          404: describeProblem("No planning area with that id in the projects this account works in."),
          409: describeProblem("The planning area already has a boundary in force over part of that period."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("param", IdParam),
      validate("json", PlanningAreaBoundaryCreate),
      async (c) => {
        const { id } = c.req.valid("param")
        const values = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const area = await findArea(tx, principal, id)
        if (area === undefined) throw noSuchArea(id)
        const row = await writeBoundary(tx, { companyId: principal.companyId, projectId: area.projectId, id: area.id }, values, "boundary")
        return c.json(boundaryOf(row), 201)
      },
    )
    .get(
      "/planning-area-boundaries",
      describeRoute({
        operationId: "listPlanningAreaBoundariesAcrossAreas",
        summary: "The boundary versions across the caller's projects' planning areas",
        description:
          "One page of boundary versions across the planning areas of the projects the caller works in, oldest written first (ids are time-ordered) — the map's Layers control reads the outlines in force today here in one request. An account that works in no project reads an empty page. `projectId` narrows it to one of those projects; naming another is refused. `planningAreaId` narrows it to one area's versions. `validOn` asks for the versions in force on that day, `validFrom` inclusive and `validTo` exclusive: at most one per area. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of boundary versions.", PlanningAreaBoundaryPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, `planningAreaId` is not an id, `validOn` is not a calendar day, or `projectId` is not a project this account works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `configure.areas`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", PlanningAreaBoundaryListQuery),
      async (c) => {
        const { limit, cursor, projectId, planningAreaId, validOn: day } = c.req.valid("query")
        const after = afterCursor(cursor)
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await c
          .get("tx")
          .select(boundaryColumns)
          .from(planningAreaBoundary)
          .where(
            and(
              boundaryScope(principal),
              projectId === undefined ? undefined : eq(planningAreaBoundary.projectId, projectId),
              planningAreaId === undefined ? undefined : eq(planningAreaBoundary.planningAreaId, planningAreaId),
              day === undefined ? undefined : validOn(planningAreaBoundary, day),
              after === undefined ? undefined : gt(planningAreaBoundary.id, after),
            ),
          )
          .orderBy(asc(planningAreaBoundary.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(boundaryOf), limit))
      },
    )
    .get(
      "/planning-area-boundaries/:id",
      describeRoute({
        operationId: "getPlanningAreaBoundary",
        summary: "One boundary version",
        description:
          "One boundary version of a planning area in a project the caller works in. A version of another company's area, or of a project this account does not work in, is a version that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The boundary version.", PlanningAreaBoundary),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `configure.areas`."),
          404: describeProblem("No planning area boundary with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findBoundary(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchBoundary(id)
        return c.json(boundaryOf(row))
      },
    )
    .patch(
      "/planning-area-boundaries/:id",
      describeRoute({
        operationId: "patchPlanningAreaBoundary",
        summary: "End or redraw a boundary version",
        description:
          "Changes the end or the outline of one boundary version; every field is optional and at least one must be given. `validTo` ends the version on that day or, as null, reopens it; the start does not move, since a version begins where the earlier one ended, and the area and the project are not patchable. The end still comes after the stored start, which a body naming one bound cannot see by itself, and the period may not overlap another version of the area (409) — an end moved past the next version's start, or a version reopened under one, is refused. A redrawn polygon is held to the same two rules as a new one: the ring and the globe are the contracts', and whether the rings make a valid polygon is PostGIS's, refused by the database and answered as a 400 on `boundary`, \"Not a valid polygon\".",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The boundary version as it now stands.", PlanningAreaBoundary),
          400: describeProblem(
            "The path does not hold an id, or the patch is empty, names a field the caller does not own (the start, the area and the project included), ends on or before the stored start, or holds a polygon that is not a closed ring on the globe or that PostGIS calls invalid.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `configure.areas`."),
          404: describeProblem("No planning area boundary with that id in the projects this account works in."),
          409: describeProblem("The planning area already has another boundary in force over part of the new period."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", PlanningAreaBoundaryPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await findBoundary(tx, principal, id)
        if (current === undefined) throw noSuchBoundary(id)
        if (patch.validTo !== undefined) requireOrdered(periodAfter(current, patch))
        const [row] = await refuseCheck(polygonInvalid("boundary"), () =>
          refuseOverlap({ [BOUNDARY_RUNNING]: BOUNDARY_RUNNING_SENTENCE }, () =>
            tx
              .update(planningAreaBoundary)
              .set(patch)
              .where(and(boundaryScope(principal), eq(planningAreaBoundary.id, id)))
              .returning(boundaryColumns),
          ),
        )
        if (row === undefined) throw noSuchBoundary(id)
        return c.json(boundaryOf(row))
      },
    )
}
