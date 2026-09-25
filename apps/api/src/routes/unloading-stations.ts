// Where a route empties (Issue #101): the Unloading Station and the fractions
// it accepts. `GET /unloading-stations` lists them, `POST /unloading-stations`
// registers one, `GET`/`PATCH /unloading-stations/:id` read and change one,
// and `PUT /unloading-stations/:id/fractions` replaces what it accepts. No
// delete: a station the schemes point at and the Unloads (step 6) will
// happen at is behind those rows, and `status: "closed"` is what "remove a
// station" means here.
//
// An Unloading Station is not a Depot and not a Warehouse, and unlike them it
// is the company's and no project's: ARC Amager is where every Copenhagen
// project unloads — the reasoning that made a Customer the company's — so
// there is no `projectId` anywhere, the code and the name are unique per
// company, and a scheme of any project may name any station of the company.
//
// The second fence still applies, in the one way a company-wide row can
// carry it. Until step 7 resolves a Service Provider's visibility through
// Service Area Assignment (ADR-0001), a provider account works in no project
// and reaches nothing of Resources (#101 §1, §4), and a station is the one
// Resources row `inProjects` cannot fence, having no project column. So every
// station statement is bounded by `reaches(principal)`: the tenant, and
// `false` for an account that works in no project at all — the same `false`
// `inProjects` answers such an account — so its list is an empty page, its
// reads are 404s, and its writes find no row; a create, which no scope can
// bound, is refused up front (403 stating the rule, since a better body would
// not help). An account that works in any project of the company reaches
// every station, since a station serves every project, and so does one that
// works in all of them while the company has none yet: `allProjects` is the
// grant, not the count, and a company registers its plant before its first
// project. This is deliberately not the rule the other company-wide families
// (waste fractions, container types, vehicle types) follow, where a provider
// with the grant reads the company's vocabulary: a vocabulary says nothing
// about the company's operation, and where it unloads does.
//
// The fractions are the set that travels with the record, through the
// company-wide, role-less sibling in routes/id-sets.ts: read with the station
// sorted by id, a page's loaded in one query, a create may carry the set it
// starts with, a patch never touches it, the PUT replaces it whole and moves
// the stamp. Every id is a waste fraction of this company (400 at
// `wasteFractionIds.N`), and a create and the PUT answer the set they were
// given, in read order, rather than reading it back. `?wasteFractionId=` on
// the list answers the stations that accept a fraction, as one `exists`, and
// is held to a fraction of this company (400 on the query), like the
// containers list's `warehouseId`.
//
// The two shape rules and the hours are the depot's (routes/place-rules.ts):
// the owning provider is named with `service-provider` ownership and with
// nothing else, the hours are both or neither, a patch is held against the
// stored row in the contracts' words under the row's lock, the table's two
// checks answer in the same words behind that, and the point goes through
// `unloading_station_location_valid` behind `refuseCheck`. The grant is
// `resources.depots`, shared with the depots (#101 §6.22: one module key, two
// families).
import type { FlatPoint } from "@waste/contracts/geojson"
import { Page } from "@waste/contracts/pagination"
import { UnloadingStation, UnloadingStationCreate, UnloadingStationFractionsSet, UnloadingStationListQuery, UnloadingStationPatch } from "@waste/contracts/places"
import type { UnloadingStationOwnership, UnloadingStationStatus } from "@waste/contracts/resources"
import type { Tx } from "@waste/db/client"
import { wasteFraction } from "@waste/db/schema/catalogue"
import { unloadingStation, unloadingStationFraction } from "@waste/db/schema/places"
import { and, asc, eq, exists, gt, sql } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { projectIdsOf } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { asRead, idsFor, idsOf, replaceIdSet, requireEachOf, writeIds, type IdSet } from "./id-sets"
import { hourOf, placeShapeInvalid, pointInvalid, requirePlaceShape } from "./place-rules"
import { requireServiceProvider, requireWasteFraction } from "./references"
import { describeJson, IdParam, lockRow, refuseCheck, refuseDuplicate, stampsOf } from "./shared"

const MODULE = "resources.depots"
const UnloadingStationPage = Page(UnloadingStation)

const columns = {
  id: unloadingStation.id,
  code: unloadingStation.code,
  name: unloadingStation.name,
  address: unloadingStation.address,
  location: unloadingStation.location,
  ownership: unloadingStation.ownership,
  serviceProviderId: unloadingStation.serviceProviderId,
  opensAt: unloadingStation.opensAt,
  closesAt: unloadingStation.closesAt,
  weighbridge: unloadingStation.weighbridge,
  status: unloadingStation.status,
  notes: unloadingStation.notes,
  createdAt: unloadingStation.createdAt,
  updatedAt: unloadingStation.updatedAt,
}

type Row = Pick<typeof unloadingStation.$inferSelect, keyof typeof columns>

/** What the station accepts: the waste fractions of this company, one row per fraction. */
const fractions: IdSet<typeof unloadingStationFraction> = {
  table: unloadingStationFraction,
  parentId: unloadingStationFraction.unloadingStationId,
  entryId: unloadingStationFraction.wasteFractionId,
  rowOf: (wasteFractionId, owner) => ({ id: newId(), companyId: owner.companyId, unloadingStationId: owner.id, wasteFractionId }),
  require: requireEachOf(wasteFraction, "wasteFractionIds", requireWasteFraction),
}

/** The row on the wire, with the fractions the page loaded for it, by id. The two coded fields are text with a CHECK in the database and an enum here; the hours drop Postgres's seconds; the point is the contracts' `FlatPoint`, since the column is flat and refuses a third ordinate on write, however the column's type spells the altitude as optional. */
function stationOf(row: Row, wasteFractionIds: readonly string[]): UnloadingStation {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    address: row.address,
    location: row.location as FlatPoint,
    ownership: row.ownership as UnloadingStationOwnership,
    serviceProviderId: row.serviceProviderId,
    opensAt: hourOf(row.opensAt),
    closesAt: hourOf(row.closesAt),
    weighbridge: row.weighbridge,
    status: row.status as UnloadingStationStatus,
    notes: row.notes,
    wasteFractionIds: [...wasteFractionIds],
    ...stampsOf(row),
  }
}

/** One station on the wire, its fractions read back the way a page reads them, so an answer equals the next read. */
async function stationWithFractions(tx: Tx, companyId: string, row: Row): Promise<UnloadingStation> {
  return stationOf(row, await idsFor(tx, fractions, companyId, row.id))
}

/** `unique (company_id, code)` and `unique (company_id, name)`: each is one station's inside a company, and free in the next. */
const CODE_TAKEN = "unloading_station_code_key"
const NAME_TAKEN = "unloading_station_name_key"
const codeTaken = (code: string) => `This company already has an unloading station coded ${JSON.stringify(code)}`
const nameTaken = (name: string) => `This company already has an unloading station called ${JSON.stringify(name)}`

/** `CHECK (st_isvalid(location) and not st_isempty(location) and <WGS 84>)`: the one check only the database runs on the point. */
const LOCATION_INVALID = "unloading_station_location_valid"

/** Every check the table runs that a body can be told about: the point, and the two shape rules behind `requirePlaceShape`. */
const CHECKS = { ...pointInvalid(LOCATION_INVALID), ...placeShapeInvalid("unloading_station") }

/** What an account that works in no project is told when it tries to register a station: the rule in the header, as a 403 since a better body would not help. */
const REACHES_NO_STATION = "This account works in no project and reaches no unloading station"

const noSuchStation = (id: string) => problem(404, { detail: `No unloading station ${id} in this company` })

/** Whether the caller works in any project of the company — or in all of them, which is a grant and holds while the company has none yet: what reaching a station, which serves every project, takes. */
const worksInAProject = (principal: Principal): boolean => principal.user.allProjects || projectIdsOf(principal).length > 0

/**
 * The rows of this company, for an account that works in a project of it:
 * what every station statement is bounded by. `false` for an account that
 * works in none, as `inProjects` answers such an account for a project-scoped
 * row, so its page is empty and its reads and writes find nothing.
 */
const reaches = (principal: Principal) => and(eq(unloadingStation.companyId, principal.companyId), worksInAProject(principal) ? undefined : sql`false`)

/** One station of this company by id, for an account that reaches it; undefined otherwise. */
async function findStation(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(unloadingStation)
    .where(and(reaches(principal), eq(unloadingStation.id, id)))
    .limit(1)
  return row
}

/** The stations that accept a fraction: one `exists` over the set, so a station accepting it twice could never read as two. */
const accepting = (companyId: string, wasteFractionId: string) =>
  exists(
    sql`(select 1 from ${unloadingStationFraction} where ${unloadingStationFraction.companyId} = ${companyId} and ${unloadingStationFraction.unloadingStationId} = ${unloadingStation.id} and ${unloadingStationFraction.wasteFractionId} = ${wasteFractionId})`,
  )

export function unloadingStationRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/unloading-stations",
      describeRoute({
        operationId: "listUnloadingStations",
        summary: "The company's unloading stations",
        description:
          "One page of the company's unloading stations, oldest first (ids are time-ordered), each with `wasteFractionIds`, what it accepts, by id. A station is the company's and serves every project, so there is no `projectId` to narrow by; an account that works in no project of the company, such as a service provider's, reads an empty page, since where the company unloads is not its to see until step 7. `status` narrows it to the stations in that state and `wasteFractionId` to the stations that accept that fraction, which must be a waste fraction of this company (400 on the query). Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of unloading stations, each with its fractions.", UnloadingStationPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, `status` is not one of the four, or `wasteFractionId` is not a waste fraction of this company."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `resources.depots`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", UnloadingStationListQuery),
      async (c) => {
        const { limit, cursor, status, wasteFractionId } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        // The fraction asked about is one of this company's, like the containers list's warehouse: a filter that names a row is held to it.
        await requireWasteFraction(tx, principal.companyId, wasteFractionId, "wasteFractionId", "query")
        const rows = await tx
          .select(columns)
          .from(unloadingStation)
          .where(
            and(
              reaches(principal),
              status === undefined ? undefined : eq(unloadingStation.status, status),
              wasteFractionId === undefined ? undefined : accepting(principal.companyId, wasteFractionId),
              after === undefined ? undefined : gt(unloadingStation.id, after),
            ),
          )
          .orderBy(asc(unloadingStation.id))
          .limit(fetchLimit(limit))
        // Paged first, so the row that only proves there is a next page is
        // not one of the stations whose fractions are loaded.
        const { items, nextCursor } = pageOf(rows, limit)
        const held = await idsOf(tx, fractions, principal.companyId, items.map((row) => row.id))
        return c.json({ items: items.map((row) => stationOf(row, held.get(row.id) ?? [])), nextCursor })
      },
    )
    .post(
      "/unloading-stations",
      describeRoute({
        operationId: "createUnloadingStation",
        summary: "Register an unloading station",
        description:
          "Registers an unloading station for the company — a station serves every project, so the body names none, and an account that works in no project of the company may not register one (403). The code is the stable reference a person quotes (`ARC-AMAGER`) and is set once; the code and the name are each unique inside the company. The location is required — a route empties at a point — and one off the globe is refused before the database sees it. The ownership has no default, since the plant the company delivers to (`external`) is as common as its own; the owning service provider is named with `service-provider` ownership and with nothing else, this company's (400 on `serviceProviderId`). The opening hours are two times, both or neither (400 on `closesAt`); an overnight window is allowed. `weighbridge` says whether the station weighs what is delivered and defaults to false; the tickets themselves are Execution's. `wasteFractionIds` is what the station starts out accepting, each a waste fraction of this company (400 at `wasteFractionIds.N` otherwise) and each named once, none when absent. The status defaults to `active`. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeJson("The unloading station as it was written, with its fractions by id.", UnloadingStation),
          400: describeProblem(
            "The body is missing a field, names a member the server owns, holds a point off the globe, names a provider without service-provider ownership or none with it, gives one opening time without the other, names the same fraction twice, or names a service provider or a waste fraction that is not this company's.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, the caller's role does not allow `create` on `resources.depots`, or the account works in no project of the company and so reaches no station."),
          409: describeProblem("The company already has an unloading station with that code, or one with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", UnloadingStationCreate),
      async (c) => {
        const { wasteFractionIds, ...values } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (!worksInAProject(principal)) throw problem(403, { detail: REACHES_NO_STATION })
        await requireServiceProvider(tx, principal.companyId, values.serviceProviderId)
        await fractions.require(tx, principal.companyId, wasteFractionIds)
        const [row] = await refuseCheck(CHECKS, () =>
          refuseDuplicate({ [CODE_TAKEN]: codeTaken(values.code), [NAME_TAKEN]: nameTaken(values.name) }, () =>
            tx
              .insert(unloadingStation)
              .values({ ...values, id: newId(), companyId: principal.companyId })
              .returning(columns),
          ),
        )
        await writeIds(tx, fractions, { companyId: principal.companyId, id: row.id }, wasteFractionIds)
        // The set just written is known — held to the company, each id once — so it is answered in read order and not read back.
        return c.json(stationOf(row, asRead(wasteFractionIds)), 201)
      },
    )
    .get(
      "/unloading-stations/:id",
      describeRoute({
        operationId: "getUnloadingStation",
        summary: "One unloading station",
        description:
          "One unloading station of the caller's company, with the fractions it accepts. Another company's station is a station that does not exist here, and so is every station to an account that works in no project of the company.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The unloading station, with its fractions by id.", UnloadingStation),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `resources.depots`."),
          404: describeProblem("No unloading station with that id in this company, or none this account reaches."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findStation(tx, principal, id)
        if (row === undefined) throw noSuchStation(id)
        return c.json(await stationWithFractions(tx, principal.companyId, row))
      },
    )
    .patch(
      "/unloading-stations/:id",
      describeRoute({
        operationId: "patchUnloadingStation",
        summary: "Change an unloading station",
        description:
          "Changes one unloading station of the caller's company; every field is optional and at least one must be given. The location may move but not be cleared, since a route empties at a point; a null clears the provider, the hours or the notes. The patch is held against the stored row, so a change that would leave the station naming a provider without service-provider ownership, or none with it, or with one opening time and not the other, is refused in the same words as on a create. The code does not change: it is the reference the schemes quote, and a station that needs another code is another station. The fractions are a set, so they are `PUT /unloading-stations/{id}/fractions`.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The unloading station as it now stands, with its fractions.", UnloadingStation),
          400: describeProblem(
            "The path does not hold an id, or the patch is empty, names a field the caller does not own (the code and the fractions included), holds a point off the globe, would leave the ownership and the provider disagreeing or one opening time without the other, or names a service provider that is not this company's.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `resources.depots`."),
          404: describeProblem("No unloading station with that id in this company, or none this account reaches."),
          409: describeProblem("The company already has another unloading station with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", UnloadingStationPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        // The row's lock, then the row, then what the patch points at and
        // what it leaves behind: the shape rules are held against the stored
        // row, and two patches of one station each read and then write, so
        // the lock makes the second read what the first wrote. An id nobody
        // minted locks nothing and is a 404 here as in every other family.
        await lockRow(tx, unloadingStation, { companyId: principal.companyId, id })
        const current = await findStation(tx, principal, id)
        if (current === undefined) throw noSuchStation(id)
        await requireServiceProvider(tx, principal.companyId, patch.serviceProviderId)
        requirePlaceShape(current, patch)

        const sentences: Record<string, string> = patch.name === undefined ? {} : { [NAME_TAKEN]: nameTaken(patch.name) }
        const [row] = await refuseCheck(CHECKS, () =>
          refuseDuplicate(sentences, () =>
            tx
              .update(unloadingStation)
              .set(patch)
              .where(and(reaches(principal), eq(unloadingStation.id, id)))
              .returning(columns),
          ),
        )
        if (row === undefined) throw noSuchStation(id)
        return c.json(await stationWithFractions(tx, principal.companyId, row))
      },
    )
    .put(
      "/unloading-stations/:id/fractions",
      describeRoute({
        operationId: "putUnloadingStationFractions",
        summary: "Replace what an unloading station accepts",
        description:
          "Replaces the whole set of fractions with the one in the body: a fraction the body leaves out is not accepted afterwards, and an empty list is a station that takes nothing yet. Every id is a waste fraction of this company (400 at `wasteFractionIds.N` otherwise), each named once (400 on `wasteFractionIds`). The station's `updatedAt` moves, since the set is part of the station on the wire.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The unloading station with the fractions it now accepts.", UnloadingStation),
          400: describeProblem(
            "The path does not hold an id, or the body is missing `wasteFractionIds`, names a member it does not own, names the same fraction twice, or names a waste fraction that is not this company's.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `resources.depots`."),
          404: describeProblem("No unloading station with that id in this company, or none this account reaches."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", UnloadingStationFractionsSet),
      async (c) => {
        const { id } = c.req.valid("param")
        const { wasteFractionIds } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await replaceIdSet(tx, fractions, principal.companyId, wasteFractionIds, (stamped) =>
          tx
            .update(unloadingStation)
            .set(stamped)
            .where(and(reaches(principal), eq(unloadingStation.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchStation(id)
        return c.json(stationOf(row, asRead(wasteFractionIds)))
      },
    )
}
