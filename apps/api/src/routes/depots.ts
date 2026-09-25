// Where a route departs from and returns to (Issue #101): the Depot.
// `GET /depots` lists them, `POST /depots` registers one, `GET`/`PATCH
// /depots/:id` read and change one. No delete: a depot the vehicles, the
// drivers, the schemes and the allocations point at is behind those rows, and
// `status: "closed"` is what "remove a depot" means here.
//
// A Depot is not a Warehouse and not an Unloading Station: the glossary keeps
// the three terms apart, and the three are three families here. A depot is
// always located — a route leaves from a point, so `location` is required and
// a patch may move it but not clear it — and it carries what the yard is: whose
// it is, its hours and how many vehicles it holds. The prototype's
// `effectiveFrom`/`effectiveTo` on a place are readings of the status's
// history in the audit log, and its `operatingHours` text is two times.
//
// Two shape rules are the depot's own, and the station's (routes/place-
// rules.ts): the owning service provider is named with `service-provider`
// ownership and with nothing else, and the opening hours are both given or
// neither — an overnight window, 22:00 to 05:00, is two times and allowed.
// The contracts hold a create body to both, since it carries the whole
// picture, and hold a patch only where it carries both halves; the route holds
// the patch against the stored row for the rest, in the contracts' words,
// under the row's lock taken before the read (two patches of one depot would
// otherwise both pass), and the table's two checks answer in the same words
// through `refuseCheck` should one get past, so a rule a client can fix never
// reaches a client as a 500. The provider named is this company's (400 on
// `serviceProviderId`).
//
// The hours are `time` columns on the project's clock, `HH:MM:SS` in Postgres
// and `HH:MM` on the wire through `timeOf` (routes/shared.ts), as a scheme's
// planned start is. The point goes in and comes back as GeoJSON through the
// column type; a point off the globe or with a third ordinate is the
// contracts' 400 at the coordinates (`FlatPoint`), and `depot_location_valid`
// stands behind that through `refuseCheck`.
//
// The rest is the shape every project-scoped family has: each statement
// carries the tenant and `inProjects` (auth/projects.ts), a create names a
// project the caller works in, a record never moves between projects, and
// the code — `DEP-NORD` — is set once and unique per project beside the name,
// each collision with its own sentence. The grant is `resources.depots`,
// which the unloading stations share (#101 §6.22: one module key, two
// families).
import type { FlatPoint } from "@waste/contracts/geojson"
import { Page } from "@waste/contracts/pagination"
import { Depot, DepotCreate, DepotListQuery, DepotPatch } from "@waste/contracts/places"
import type { DepotOwnership, DepotStatus } from "@waste/contracts/resources"
import type { Tx } from "@waste/db/client"
import { depot } from "@waste/db/schema/places"
import { and, asc, eq, gt } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { hourOf, placeShapeInvalid, pointInvalid, requirePlacePatch } from "./place-rules"
import { requireServiceProvider } from "./references"
import { created, describeCreated, describeJson, IdParam, lockRow, refuseCheck, refuseDuplicate, stampsOf } from "./shared"

const MODULE = "resources.depots"
const DepotPage = Page(Depot)

const columns = {
  id: depot.id,
  projectId: depot.projectId,
  code: depot.code,
  name: depot.name,
  address: depot.address,
  location: depot.location,
  ownership: depot.ownership,
  serviceProviderId: depot.serviceProviderId,
  opensAt: depot.opensAt,
  closesAt: depot.closesAt,
  vehicleCapacity: depot.vehicleCapacity,
  status: depot.status,
  notes: depot.notes,
  createdAt: depot.createdAt,
  updatedAt: depot.updatedAt,
}

type Row = Pick<typeof depot.$inferSelect, keyof typeof columns>

/** The row on the wire. The two coded fields are text with a CHECK in the database and an enum here; the hours drop Postgres's seconds; the point is the contracts' `FlatPoint`, since the column is flat and refuses a third ordinate on write, however the column's type spells the altitude as optional. */
function depotOf(row: Row): Depot {
  return {
    id: row.id,
    projectId: row.projectId,
    code: row.code,
    name: row.name,
    address: row.address,
    location: row.location as FlatPoint,
    ownership: row.ownership as DepotOwnership,
    serviceProviderId: row.serviceProviderId,
    opensAt: hourOf(row.opensAt),
    closesAt: hourOf(row.closesAt),
    vehicleCapacity: row.vehicleCapacity,
    status: row.status as DepotStatus,
    notes: row.notes,
    ...stampsOf(row),
  }
}

/** `unique (company_id, project_id, code)` and `unique (company_id, project_id, name)`: each is one depot's inside a project, and free in the next. */
const CODE_TAKEN = "depot_project_id_code_key"
const NAME_TAKEN = "depot_project_id_name_key"
const codeTaken = (code: string) => `This project already has a depot coded ${JSON.stringify(code)}`
const nameTaken = (name: string) => `This project already has a depot called ${JSON.stringify(name)}`

/** `CHECK (st_isvalid(location) and not st_isempty(location) and <WGS 84>)`: the one check only the database runs on the point. */
const LOCATION_INVALID = "depot_location_valid"

/** Every check the table runs that a body can be told about: the point, and the two shape rules behind `requirePlaceShape`. */
const CHECKS = { ...pointInvalid(LOCATION_INVALID), ...placeShapeInvalid("depot") }

const noSuchDepot = (id: string) => problem(404, { detail: `No depot ${id} in the projects this account works in` })

/** The rows of this company, in the projects the caller works in: what every depot statement is bounded by. */
const scope = (principal: Principal) => and(eq(depot.companyId, principal.companyId), inProjects(depot.projectId, principal))

/** One depot of this company by id, inside the caller's projects; undefined when it is neither. */
async function findDepot(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(depot)
    .where(and(scope(principal), eq(depot.id, id)))
    .limit(1)
  return row
}

export function depotRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/depots",
      describeRoute({
        operationId: "listDepots",
        summary: "The depots of the caller's projects",
        description:
          "One page of depots, oldest first (ids are time-ordered), from the projects the caller works in — an account that works in none, such as a service provider's, reads an empty page. `projectId` narrows it to one of those projects; naming another is refused. `status` narrows it to the depots in that state. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of depots.", DepotPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, `status` is not one of the four, or `projectId` is not a project this account works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `resources.depots`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", DepotListQuery),
      async (c) => {
        const { limit, cursor, projectId, status } = c.req.valid("query")
        const after = afterCursor(cursor)
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await c
          .get("tx")
          .select(columns)
          .from(depot)
          .where(
            and(
              scope(principal),
              projectId === undefined ? undefined : eq(depot.projectId, projectId),
              status === undefined ? undefined : eq(depot.status, status),
              after === undefined ? undefined : gt(depot.id, after),
            ),
          )
          .orderBy(asc(depot.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(depotOf), limit))
      },
    )
    .post(
      "/depots",
      describeRoute({
        operationId: "createDepot",
        summary: "Register a depot",
        description:
          "Registers a depot in one project, which must be a project the caller works in. The code is the stable reference a person quotes (`DEP-NORD`) and is set once; the code and the name are each unique inside the project. The location is required — a route departs from a point — and one off the globe is refused before the database sees it. The ownership defaults to `company`, and the owning service provider is named with `service-provider` ownership and with nothing else, this company's (400 on `serviceProviderId`). The opening hours are two times on the project's clock, both or neither (400 on `closesAt`); an overnight window, 22:00 to 05:00, is allowed. `vehicleCapacity`, where given, is a whole number above zero. The status defaults to `active`. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The depot as it was written.", Depot),
          400: describeProblem(
            "The body is missing a field, names a member the server owns, names a project this account does not work in, holds a point off the globe, names a provider with company ownership or none with service-provider ownership, gives one opening time without the other, gives a capacity of nothing, or names a service provider that is not this company's.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `resources.depots`."),
          409: describeProblem("The project already has a depot with that code, or one with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", DepotCreate),
      async (c) => {
        const values = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, values.projectId)
        await requireServiceProvider(tx, principal.companyId, values.serviceProviderId)
        const [row] = await refuseCheck(CHECKS, () =>
          refuseDuplicate({ [CODE_TAKEN]: codeTaken(values.code), [NAME_TAKEN]: nameTaken(values.name) }, () =>
            tx
              .insert(depot)
              .values({ ...values, id: newId(), companyId: principal.companyId })
              .returning(columns),
          ),
        )
        return created(c, "/depots", depotOf(row))
      },
    )
    .get(
      "/depots/:id",
      describeRoute({
        operationId: "getDepot",
        summary: "One depot",
        description:
          "One depot of a project the caller works in. A depot of another company, or of a project this account does not work in, is a depot that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The depot.", Depot),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `resources.depots`."),
          404: describeProblem("No depot with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findDepot(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchDepot(id)
        return c.json(depotOf(row))
      },
    )
    .patch(
      "/depots/:id",
      describeRoute({
        operationId: "patchDepot",
        summary: "Change a depot",
        description:
          "Changes one depot of a project the caller works in; every field is optional and at least one must be given. The location may move but not be cleared, since a route departs from a point; a null clears the provider, the hours, the capacity or the notes. The patch is held against the stored row, so a change that would leave the depot naming a provider with company ownership, or none with service-provider ownership, or with one opening time and not the other, is refused in the same words as on a create — and a provider that is not this company's beside them, every refusal listed in the one 400. The code does not change: it is the reference the schemes and the vehicles quote, and a depot that needs another code is another depot. The project is not patchable, since a record does not move between projects.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The depot as it now stands.", Depot),
          400: describeProblem(
            "The path does not hold an id, or the patch is empty, names a field the caller does not own (the code and the project included), holds a point off the globe, would leave the ownership and the provider disagreeing or one opening time without the other, or names a service provider that is not this company's.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `resources.depots`."),
          404: describeProblem("No depot with that id in the projects this account works in."),
          409: describeProblem("The project already has another depot with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", DepotPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        // The row's lock, then the row, then what the patch points at and
        // what it leaves behind: the shape rules are held against the stored
        // row, and two patches of one depot each read and then write, so the
        // lock makes the second read what the first wrote (routes/shared.ts).
        // An id nobody minted locks nothing and is a 404 here as in every
        // other family.
        await lockRow(tx, depot, { companyId: principal.companyId, id })
        const current = await findDepot(tx, principal, id)
        if (current === undefined) throw noSuchDepot(id)
        // The provider's existence and the two shape rules, every refusal in one 400 (routes/place-rules.ts).
        await requirePlacePatch(tx, principal.companyId, current, patch)

        const sentences: Record<string, string> = patch.name === undefined ? {} : { [NAME_TAKEN]: nameTaken(patch.name) }
        const [row] = await refuseCheck(CHECKS, () =>
          refuseDuplicate(sentences, () =>
            tx
              .update(depot)
              .set(patch)
              .where(and(scope(principal), eq(depot.id, id)))
              .returning(columns),
          ),
        )
        if (row === undefined) throw noSuchDepot(id)
        return c.json(depotOf(row))
      },
    )
}
