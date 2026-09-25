// Where containers are stocked and repaired (Issue #101, ADR-0003): the
// Warehouse. `GET /warehouses` lists them, `POST /warehouses` registers one,
// `GET`/`PATCH /warehouses/:id` read and change one. No delete: a warehouse
// the Stock Movement ledger names as where a container came from or went to
// is behind those rows, and `status: "closed"` is what "remove a warehouse"
// means here.
//
// A Warehouse is not a Depot and not an Unloading Station — the glossary keeps
// the three apart, and the prototype's mixed "Depots & Unloading" tab is
// split into three families here. Colocation (Nordhavn's depot and its
// warehouse in one yard) is one pointer, `depotId`, and not two that can
// disagree: a depot of the warehouse's own project (400 on `depotId`), since
// the composite key carries the project. What the prototype carried beside
// that — zones, fungible stock flags, a scan rule — is inventory's and waits
// for stock items; a warehouse's stock position is a count over the ledger's
// projection and never a column.
//
// The location is nullable, like a property's: a warehouse is registered
// before it is geocoded. It goes in and comes back as GeoJSON through the
// column type (@waste/db/schema/geometry); a point off the globe, or one with
// a third ordinate, is the contracts' 400 at the coordinates before the
// database sees it (`FlatPoint`, since the column is flat), and
// `warehouse_location_valid` stands behind that as `refuseCheck`'s 400 on
// `location` (routes/place-rules.ts says why the door is a backstop for a
// point).
//
// The rest is the shape every project-scoped family has: each statement
// carries the tenant and `inProjects` (auth/projects.ts), a create names a
// project the caller works in, a record never moves between projects, and
// the code — the stable reference a person quotes, `WH-WEST` — is set once
// and unique per project beside the name, each collision with its own
// sentence. The grant is `resources.warehouses`.
import type { FlatPoint } from "@waste/contracts/geojson"
import { Page } from "@waste/contracts/pagination"
import { Warehouse, WarehouseCreate, WarehouseListQuery, WarehousePatch } from "@waste/contracts/places"
import type { WarehouseStatus } from "@waste/contracts/resources"
import type { Tx } from "@waste/db/client"
import { warehouse } from "@waste/db/schema/places"
import { and, asc, eq, gt } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { pointInvalid } from "./place-rules"
import { requireDepot } from "./references"
import { created, describeCreated, describeJson, IdParam, refuseCheck, refuseDuplicate, stampsOf } from "./shared"

const MODULE = "resources.warehouses"
const WarehousePage = Page(Warehouse)

const columns = {
  id: warehouse.id,
  projectId: warehouse.projectId,
  code: warehouse.code,
  name: warehouse.name,
  address: warehouse.address,
  location: warehouse.location,
  depotId: warehouse.depotId,
  status: warehouse.status,
  notes: warehouse.notes,
  createdAt: warehouse.createdAt,
  updatedAt: warehouse.updatedAt,
}

type Row = Pick<typeof warehouse.$inferSelect, keyof typeof columns>

/** The row on the wire. `status` is text with a CHECK in the database and an enum here, both read off the one vocabulary tuple; the point arrives as the GeoJSON the column type decoded. The column is `geometry(Point, 4326)`, flat — a third ordinate is refused on write — so what it holds is the contracts' `FlatPoint` however the column's type spells the altitude as optional. */
function warehouseOf(row: Row): Warehouse {
  return {
    id: row.id,
    projectId: row.projectId,
    code: row.code,
    name: row.name,
    address: row.address,
    location: row.location as FlatPoint | null,
    depotId: row.depotId,
    status: row.status as WarehouseStatus,
    notes: row.notes,
    ...stampsOf(row),
  }
}

/** `unique (company_id, project_id, code)` and `unique (company_id, project_id, name)`: each is one warehouse's inside a project, and free in the next. */
const CODE_TAKEN = "warehouse_project_id_code_key"
const NAME_TAKEN = "warehouse_project_id_name_key"
const codeTaken = (code: string) => `This project already has a warehouse coded ${JSON.stringify(code)}`
const nameTaken = (name: string) => `This project already has a warehouse called ${JSON.stringify(name)}`

/** `CHECK (st_isvalid(location) and not st_isempty(location) and <WGS 84>)`: the one check only the database runs on the point. */
const LOCATION_INVALID = "warehouse_location_valid"

const noSuchWarehouse = (id: string) => problem(404, { detail: `No warehouse ${id} in the projects this account works in` })

/** The rows of this company, in the projects the caller works in: what every warehouse statement is bounded by. */
const scope = (principal: Principal) => and(eq(warehouse.companyId, principal.companyId), inProjects(warehouse.projectId, principal))

/** One warehouse of this company by id, inside the caller's projects; undefined when it is neither. */
async function findWarehouse(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(warehouse)
    .where(and(scope(principal), eq(warehouse.id, id)))
    .limit(1)
  return row
}

export function warehouseRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/warehouses",
      describeRoute({
        operationId: "listWarehouses",
        summary: "The warehouses of the caller's projects",
        description:
          "One page of warehouses, oldest first (ids are time-ordered), from the projects the caller works in — an account that works in none, such as a service provider's, reads an empty page. `projectId` narrows it to one of those projects; naming another is refused. `status` narrows it to the warehouses in that state. What stands in a warehouse is the ledger's reading, `GET /containers?warehouseId=`. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of warehouses.", WarehousePage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, `status` is not one of the four, or `projectId` is not a project this account works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `resources.warehouses`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", WarehouseListQuery),
      async (c) => {
        const { limit, cursor, projectId, status } = c.req.valid("query")
        const after = afterCursor(cursor)
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await c
          .get("tx")
          .select(columns)
          .from(warehouse)
          .where(
            and(
              scope(principal),
              projectId === undefined ? undefined : eq(warehouse.projectId, projectId),
              status === undefined ? undefined : eq(warehouse.status, status),
              after === undefined ? undefined : gt(warehouse.id, after),
            ),
          )
          .orderBy(asc(warehouse.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(warehouseOf), limit))
      },
    )
    .post(
      "/warehouses",
      describeRoute({
        operationId: "createWarehouse",
        summary: "Register a warehouse",
        description:
          "Registers a warehouse in one project, which must be a project the caller works in. The code is the stable reference a person quotes (`WH-WEST`) and is set once; the code and the name are each unique inside the project. The location is null until the warehouse is geocoded, and a point off the globe is refused before the database sees it. `depotId`, where given, is the depot the warehouse shares a yard with and must be a depot of the same project: colocation is one pointer, not two that can disagree. The status defaults to `active`. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The warehouse as it was written.", Warehouse),
          400: describeProblem(
            "The body is missing a field, names a member the server owns, names a project this account does not work in, holds a point off the globe, or names a depot that is not of this project.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `resources.warehouses`."),
          409: describeProblem("The project already has a warehouse with that code, or one with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", WarehouseCreate),
      async (c) => {
        const values = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, values.projectId)
        await requireDepot(tx, { companyId: principal.companyId, projectId: values.projectId }, values.depotId)
        const [row] = await refuseCheck(pointInvalid(LOCATION_INVALID), () =>
          refuseDuplicate({ [CODE_TAKEN]: codeTaken(values.code), [NAME_TAKEN]: nameTaken(values.name) }, () =>
            tx
              .insert(warehouse)
              .values({ ...values, id: newId(), companyId: principal.companyId })
              .returning(columns),
          ),
        )
        return created(c, "/warehouses", warehouseOf(row))
      },
    )
    .get(
      "/warehouses/:id",
      describeRoute({
        operationId: "getWarehouse",
        summary: "One warehouse",
        description:
          "One warehouse of a project the caller works in. A warehouse of another company, or of a project this account does not work in, is a warehouse that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The warehouse.", Warehouse),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `resources.warehouses`."),
          404: describeProblem("No warehouse with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findWarehouse(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchWarehouse(id)
        return c.json(warehouseOf(row))
      },
    )
    .patch(
      "/warehouses/:id",
      describeRoute({
        operationId: "patchWarehouse",
        summary: "Change a warehouse",
        description:
          "Changes one warehouse of a project the caller works in; every field is optional and at least one must be given. A null clears the location, the colocated depot or the notes; a depot named must be one of the warehouse's own project. The code does not change: it is the reference the ledger and a report quote, and a warehouse that needs another code is another warehouse. The project is not patchable, since a record does not move between projects.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The warehouse as it now stands.", Warehouse),
          400: describeProblem(
            "The path does not hold an id, or the patch is empty, names a field the caller does not own (the code and the project included), holds a point off the globe, or names a depot that is not of this project.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `resources.warehouses`."),
          404: describeProblem("No warehouse with that id in the projects this account works in."),
          409: describeProblem("The project already has another warehouse with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", WarehousePatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        // The row first, then what the patch points at: an id nobody minted
        // is a 404 here as in every other family, and not a 400 about a depot
        // that was never going to be written.
        const current = await findWarehouse(tx, principal, id)
        if (current === undefined) throw noSuchWarehouse(id)
        await requireDepot(tx, { companyId: principal.companyId, projectId: current.projectId }, patch.depotId)

        const sentences: Record<string, string> = patch.name === undefined ? {} : { [NAME_TAKEN]: nameTaken(patch.name) }
        const [row] = await refuseCheck(pointInvalid(LOCATION_INVALID), () =>
          refuseDuplicate(sentences, () =>
            tx
              .update(warehouse)
              .set(patch)
              .where(and(scope(principal), eq(warehouse.id, id)))
              .returning(columns),
          ),
        )
        if (row === undefined) throw noSuchWarehouse(id)
        return c.json(warehouseOf(row))
      },
    )
}
