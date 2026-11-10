// Where residents bring waste themselves (Issue #293, M3): a project's
// Drop-off Points, its recycling centres and bring banks, with the three sets
// that travel with each — the fractions it takes, its weekly hours, its dated
// exceptions. `GET /drop-off-points` lists them, `POST /drop-off-points`
// registers one, `GET`/`PATCH /drop-off-points/:id` read and change one, and
// `PUT /drop-off-points/:id/fractions`, `…/hours` and `…/exceptions` each
// replace one set whole. No delete: `status: "closed"` is what removing a
// point means, and a draft is the office's alone until it is made active and
// reaches the public map (routes/public.ts).
//
// A point is the project's, as a depot is: every statement carries the
// tenant and `inProjects`, a create names a project the caller works in, the
// code and the name are unique per project, and the code is set once. The
// sets are project-scoped beside the point and written with its project;
// each is read with the point (a page's in one query per set) and replaced
// delete-then-insert inside the request's transaction, the point's row
// stamped first so a missing point is a 404 before anything is written. A
// create and a PUT answer the set as the next read gives it: fractions by id,
// hours by weekday and opening, exceptions by date.
//
// The sets are judged by the domain's own rules in the contracts
// (`hoursIssues`, `exceptionIssues`), the ones the public map reads the days
// by; the table's two window checks stand behind them. Every fraction is a
// waste fraction of this company (400 at `wasteFractionIds.N`). The grant is
// `resources.drop-off-points`.
import type { DropOffPoint, OpeningException, WeeklyWindow } from "@waste/contracts/drop-off-points"
import { DropOffPointCreate, DropOffPointExceptionsSet, DropOffPointFractionsSet, DropOffPointHoursSet, DropOffPointListQuery, DropOffPointPatch, DropOffPoint as DropOffPointSchema } from "@waste/contracts/drop-off-points"
import type { FlatPoint } from "@waste/contracts/geojson"
import { Page } from "@waste/contracts/pagination"
import type { ServiceDay } from "@waste/contracts/planning"
import type { Tx } from "@waste/db/client"
import { wasteFraction } from "@waste/db/schema/catalogue"
import { dropOffPoint, dropOffPointException, dropOffPointFraction, dropOffPointHours } from "@waste/db/schema/drop-off-points"
import { SERVICE_DAYS } from "@waste/domain/planning/vocabulary"
import { and, eq } from "drizzle-orm"
import { newId } from "@waste/db/ids"
import { refuseCheck, refuseDuplicate } from "@waste/db/commands/shared"
import { stampsOf, timeOf } from "@waste/db/shapes/times"

import type { Principal } from "../auth/principal"
import { requireProject } from "../auth/projects"
import type { RouteDeps } from "../deps"
import { created, describeCreated, describeJson, IdParam, routes } from "../operation"
import { pageAt } from "../pagination"
import { describeProblem } from "../problem"
import { scoped } from "../scoped"
import { requireEachOf } from "./id-sets"
import { pointInvalid } from "./place-rules"
import { requireWasteFraction } from "./references"
import { groupedBy } from "./sets"
import { stamp } from "./shared"

const MODULE = "resources.drop-off-points"
const DropOffPointPage = Page(DropOffPointSchema)

const columns = {
  id: dropOffPoint.id,
  projectId: dropOffPoint.projectId,
  code: dropOffPoint.code,
  name: dropOffPoint.name,
  kind: dropOffPoint.kind,
  address: dropOffPoint.address,
  location: dropOffPoint.location,
  openAlways: dropOffPoint.openAlways,
  closedOnHolidays: dropOffPoint.closedOnHolidays,
  publicNote: dropOffPoint.publicNote,
  status: dropOffPoint.status,
  notes: dropOffPoint.notes,
  createdAt: dropOffPoint.createdAt,
  updatedAt: dropOffPoint.updatedAt,
}

type Row = Pick<typeof dropOffPoint.$inferSelect, keyof typeof columns>

type Sets = { wasteFractionIds: string[]; hours: WeeklyWindow[]; exceptions: OpeningException[] }

const NO_SETS: Sets = { wasteFractionIds: [], hours: [], exceptions: [] }

/** The weekdays in the week's order, Monday first, for the hours' read order. */
const WEEKDAY_ORDER = new Map<string, number>(SERVICE_DAYS.map((day, index) => [day, index]))

const byWeekdayThenOpening = (a: WeeklyWindow, b: WeeklyWindow) => (WEEKDAY_ORDER.get(a.weekday) ?? 0) - (WEEKDAY_ORDER.get(b.weekday) ?? 0) || a.opensAt.localeCompare(b.opensAt)

const byDate = (a: OpeningException, b: OpeningException) => a.date.localeCompare(b.date)

/** The sets of a body or a create in the order the next read gives them. */
const inReadOrder = (sets: Sets): Sets => ({
  wasteFractionIds: [...sets.wasteFractionIds].sort(),
  hours: [...sets.hours].sort(byWeekdayThenOpening),
  exceptions: [...sets.exceptions].sort(byDate),
})

/** The row on the wire with its sets. The coded fields are text with a CHECK in the database and an enum here; the point is the contracts' `FlatPoint`. */
function pointOf(row: Row, sets: Sets): DropOffPoint {
  return {
    id: row.id,
    projectId: row.projectId,
    code: row.code,
    name: row.name,
    kind: row.kind,
    address: row.address,
    location: row.location as FlatPoint,
    openAlways: row.openAlways,
    closedOnHolidays: row.closedOnHolidays,
    publicNote: row.publicNote,
    status: row.status,
    notes: row.notes,
    ...sets,
    ...stampsOf(row),
  }
}

async function setsOf(tx: Tx, companyId: string, pointIds: readonly string[]): Promise<Map<string, Sets>> {
  const [fractions, hours, exceptions] = [
    await groupedBy(tx, dropOffPointFraction, dropOffPointFraction.dropOffPointId, { id: dropOffPointFraction.wasteFractionId }, [dropOffPointFraction.wasteFractionId], companyId, pointIds),
    await groupedBy(
      tx,
      dropOffPointHours,
      dropOffPointHours.dropOffPointId,
      { weekday: dropOffPointHours.weekday, opensAt: dropOffPointHours.opensAt, closesAt: dropOffPointHours.closesAt },
      [dropOffPointHours.opensAt],
      companyId,
      pointIds,
    ),
    await groupedBy(
      tx,
      dropOffPointException,
      dropOffPointException.dropOffPointId,
      { day: dropOffPointException.day, opensAt: dropOffPointException.opensAt, closesAt: dropOffPointException.closesAt, note: dropOffPointException.note },
      [dropOffPointException.day],
      companyId,
      pointIds,
    ),
  ]
  return new Map(
    pointIds.map((id) => [
      id,
      {
        wasteFractionIds: (fractions.get(id) ?? []).map((entry) => entry.id),
        hours: (hours.get(id) ?? []).map((entry) => ({ weekday: entry.weekday as ServiceDay, opensAt: timeOf(entry.opensAt), closesAt: timeOf(entry.closesAt) })).sort(byWeekdayThenOpening),
        exceptions: (exceptions.get(id) ?? []).map((entry) => ({
          date: entry.day,
          opensAt: entry.opensAt === null ? null : timeOf(entry.opensAt),
          closesAt: entry.closesAt === null ? null : timeOf(entry.closesAt),
          note: entry.note,
        })),
      },
    ]),
  )
}

/** One point on the wire, its sets read back as a page reads them. */
async function withSets(tx: Tx, companyId: string, row: Row): Promise<DropOffPoint> {
  return pointOf(row, (await setsOf(tx, companyId, [row.id])).get(row.id) ?? NO_SETS)
}

/** The point a set hangs on: its tenant, its project and its id, which every row of the set carries. */
type Owner = { companyId: string; projectId: string; id: string }

const requireFractions = requireEachOf(wasteFraction, "wasteFractionIds", requireWasteFraction)

const writers = {
  async wasteFractionIds(tx: Tx, owner: Owner, ids: readonly string[]) {
    // The contracts hold each id to being named once (`eachOnce`); a body that reached here otherwise is a bug, thrown, never a second row or the key's 23505.
    if (new Set(ids).size !== ids.length) throw new Error("drop-off point fractions: an id named twice reached the write")
    await tx.delete(dropOffPointFraction).where(and(eq(dropOffPointFraction.companyId, owner.companyId), eq(dropOffPointFraction.dropOffPointId, owner.id)))
    if (ids.length > 0) await tx.insert(dropOffPointFraction).values(ids.map((wasteFractionId) => ({ id: newId(), companyId: owner.companyId, projectId: owner.projectId, dropOffPointId: owner.id, wasteFractionId })))
  },
  async hours(tx: Tx, owner: Owner, hours: readonly WeeklyWindow[]) {
    await tx.delete(dropOffPointHours).where(and(eq(dropOffPointHours.companyId, owner.companyId), eq(dropOffPointHours.dropOffPointId, owner.id)))
    if (hours.length > 0) await tx.insert(dropOffPointHours).values(hours.map((window) => ({ id: newId(), companyId: owner.companyId, projectId: owner.projectId, dropOffPointId: owner.id, ...window })))
  },
  async exceptions(tx: Tx, owner: Owner, exceptions: readonly OpeningException[]) {
    await tx.delete(dropOffPointException).where(and(eq(dropOffPointException.companyId, owner.companyId), eq(dropOffPointException.dropOffPointId, owner.id)))
    if (exceptions.length > 0) {
      await tx
        .insert(dropOffPointException)
        .values(exceptions.map(({ date, ...rest }) => ({ id: newId(), companyId: owner.companyId, projectId: owner.projectId, dropOffPointId: owner.id, day: date, ...rest })))
    }
  },
}

/** `unique (company_id, project_id, code)` and `unique (company_id, project_id, name)`: each one point's inside a project, and free in the next. */
const CODE_TAKEN = "drop_off_point_project_id_code_key"
const NAME_TAKEN = "drop_off_point_project_id_name_key"
const codeTaken = (code: string) => `This project already has a drop-off point coded ${JSON.stringify(code)}`
const nameTaken = (name: string) => `This project already has a drop-off point called ${JSON.stringify(name)}`

/** The one check only the database runs on the point. */
const CHECKS = pointInvalid("drop_off_point_location_valid")

const { scope, noSuch: noSuchPoint, get: getPoint, list: listPoints } = scoped(dropOffPoint, { noun: "drop-off point", reach: "projects", columns })

async function stampPoint(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .update(dropOffPoint)
    .set(stamp())
    .where(and(scope(principal), eq(dropOffPoint.id, id)))
    .returning(columns)
  return row
}

const SET_ROUTES = [
  {
    path: "fractions",
    key: "wasteFractionIds",
    operationId: "putDropOffPointFractions",
    summary: "Replace the fractions a drop-off point takes",
    description:
      "Replaces the whole set of fractions with the one in the body: a fraction left out is not taken afterwards, and an empty list is a point that takes nothing yet. Every id is a waste fraction of this company (400 at `wasteFractionIds.N`), each named once. The point's `updatedAt` moves.",
    schema: DropOffPointFractionsSet,
  },
  {
    path: "hours",
    key: "hours",
    operationId: "putDropOffPointHours",
    summary: "Replace a drop-off point's weekly hours",
    description:
      "Replaces the whole week of windows with the one in the body. A window is a weekday and two `HH:MM` times on the project's clock, opening before it closes on the day; a weekday may have several (a lunch break), never overlapping (400 on `hours`, one sentence a problem). An empty list is a point closed every day but for its exceptions, unless it is open always. The point's `updatedAt` moves.",
    schema: DropOffPointHoursSet,
  },
  {
    path: "exceptions",
    key: "exceptions",
    operationId: "putDropOffPointExceptions",
    summary: "Replace a drop-off point's dated exceptions",
    description:
      "Replaces the whole set of exceptions with the one in the body. An exception is a date with its own window, or both times null for closed all day, and a note a resident reads (`Christmas Eve`); one a date (400 on `exceptions`). An exception wins over the week and over the project's holidays. The point's `updatedAt` moves.",
    schema: DropOffPointExceptionsSet,
  },
] as const

export function dropOffPointRoutes(deps: RouteDeps) {
  const declared = routes(deps)
    .get(
      "/drop-off-points",
      {
        operationId: "listDropOffPoints",
        summary: "The drop-off points of the caller's projects",
        description:
          "One page of drop-off points, oldest first (ids are time-ordered), from the projects the caller works in, each with its fractions, hours and exceptions. `projectId` narrows it to one of those projects; naming another is refused. `status` and `kind` narrow it further. Hand `nextCursor` back as `cursor` for the next page.",
        module: MODULE,
        action: "view",
        query: DropOffPointListQuery,
        invalid: ["`projectId` is not a project this account works in", "`status` or `kind` is not one of its values"],
        responses: {
          200: describeJson("One page of drop-off points with their sets.", DropOffPointPage),
        },
      },
      async (c) => {
        const { limit, cursor, projectId, status, kind } = c.req.valid("query")
        const at = pageAt({ cursor, limit })
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const { items, nextCursor } = await listPoints(tx, principal, at, projectId === undefined ? undefined : eq(dropOffPoint.projectId, projectId), status === undefined ? undefined : eq(dropOffPoint.status, status), kind === undefined ? undefined : eq(dropOffPoint.kind, kind))
        const sets = await setsOf(tx, principal.companyId, items.map((row) => row.id))
        return c.json({ items: items.map((row) => pointOf(row, sets.get(row.id) ?? NO_SETS)), nextCursor })
      },
    )
    .post(
      "/drop-off-points",
      {
        operationId: "createDropOffPoint",
        summary: "Register a drop-off point",
        description:
          "Registers a drop-off point in a project the caller works in. The code is the stable reference a person quotes (`GS-AMAGER`) and is set once; the code and the name are each unique inside the project. The location is required — the public map draws it — and one off the globe is refused. `kind` is `recycling-centre` or `bring-bank`. `openAlways` marks a point with no hours and `closedOnHolidays` closes it on the project's holidays; both default to false. The status defaults to `draft`: a point reaches the public map when it is made `active`. The body may carry the sets it starts with — `wasteFractionIds`, each a waste fraction of this company; `hours`; `exceptions` — judged as their own routes judge them, each empty when absent. `notes` are the office's own and never public; `publicNote` is shown on the map. The server mints the id.",
        module: MODULE,
        action: "create",
        body: DropOffPointCreate,
        invalid: ["the body is missing a field, names a member the server owns, names a project the caller does not work in, holds a point off the globe, names the same fraction twice or one that is not this company's, or holds hours or exceptions the rules refuse"],
        responses: {
          201: describeCreated("The drop-off point as it was written, with its sets.", DropOffPointSchema),
          409: describeProblem("The project already has a drop-off point with that code, or one with that name."),
        },
      },
      async (c) => {
        const { wasteFractionIds, hours, exceptions, ...values } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, values.projectId)
        await requireFractions(tx, principal.companyId, wasteFractionIds)
        const [row] = await refuseCheck(CHECKS, () =>
          refuseDuplicate({ [CODE_TAKEN]: codeTaken(values.code), [NAME_TAKEN]: nameTaken(values.name) }, () =>
            tx
              .insert(dropOffPoint)
              .values({ ...values, id: newId(), companyId: principal.companyId })
              .returning(columns),
          ),
        )
        const owner = { companyId: principal.companyId, projectId: row.projectId, id: row.id }
        await writers.wasteFractionIds(tx, owner, wasteFractionIds)
        await writers.hours(tx, owner, hours)
        await writers.exceptions(tx, owner, exceptions)
        return created(c, "/drop-off-points", pointOf(row, inReadOrder({ wasteFractionIds, hours, exceptions })))
      },
    )
    .get(
      "/drop-off-points/:id",
      {
        operationId: "getDropOffPoint",
        summary: "One drop-off point",
        description: "One drop-off point of the caller's projects, with its fractions, hours and exceptions.",
        module: MODULE,
        action: "view",
        params: IdParam,
        responses: {
          200: describeJson("The drop-off point with its sets.", DropOffPointSchema),
          404: describeProblem("No drop-off point with that id in the projects this account works in."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await getPoint(tx, principal, id)
        return c.json(await withSets(tx, principal.companyId, row))
      },
    )
    .patch(
      "/drop-off-points/:id",
      {
        operationId: "patchDropOffPoint",
        summary: "Change a drop-off point",
        description:
          "Changes one drop-off point of the caller's projects; every field is optional and at least one must be given. The location may move but not be cleared. Making the point `active` puts it on the public map of a published project; `closed` takes it off. The project and the code do not change, and the sets are their own routes.",
        module: MODULE,
        action: "edit",
        params: IdParam,
        body: DropOffPointPatch,
        invalid: ["the patch is empty, names a field the caller does not own (the project, the code and the sets included), or holds a point off the globe"],
        responses: {
          200: describeJson("The drop-off point as it now stands, with its sets.", DropOffPointSchema),
          404: describeProblem("No drop-off point with that id in the projects this account works in."),
          409: describeProblem("The project already has another drop-off point with that name."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const sentences: Record<string, string> = patch.name === undefined ? {} : { [NAME_TAKEN]: nameTaken(patch.name) }
        const [row] = await refuseCheck(CHECKS, () =>
          refuseDuplicate(sentences, () =>
            tx
              .update(dropOffPoint)
              .set(patch)
              .where(and(scope(principal), eq(dropOffPoint.id, id)))
              .returning(columns),
          ),
        )
        if (row === undefined) throw noSuchPoint(id)
        return c.json(await withSets(tx, principal.companyId, row))
      },
    )

  for (const set of SET_ROUTES) {
    declared.put(
      `/drop-off-points/:id/${set.path}`,
      {
        operationId: set.operationId,
        summary: set.summary,
        description: set.description,
        module: MODULE,
        action: "edit",
        params: IdParam,
        body: set.schema,
        invalid: [`the body is missing \`${set.key}\`, names a member it does not own, or holds a set the rules refuse`],
        responses: {
          200: describeJson("The drop-off point with the set it now has.", DropOffPointSchema),
          404: describeProblem("No drop-off point with that id in the projects this account works in."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const body = c.req.valid("json") as Partial<Sets>
        const tx = c.get("tx")
        const principal = c.get("principal")
        // The path's own row first (404), then the body's fractions (400): a refusal discards the stamp with the transaction.
        const row = await stampPoint(tx, principal, id)
        if (row === undefined) throw noSuchPoint(id)
        if (body.wasteFractionIds !== undefined) await requireFractions(tx, principal.companyId, body.wasteFractionIds)
        const owner = { companyId: principal.companyId, projectId: row.projectId, id: row.id }
        if (body.wasteFractionIds !== undefined) await writers.wasteFractionIds(tx, owner, body.wasteFractionIds)
        if (body.hours !== undefined) await writers.hours(tx, owner, body.hours)
        if (body.exceptions !== undefined) await writers.exceptions(tx, owner, body.exceptions)
        return c.json(await withSets(tx, principal.companyId, row))
      },
    )
  }
  return declared
}
