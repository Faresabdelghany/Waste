// The Vehicle Type (Issue #101, ADR-0002): a company's row, and the
// compatibility Planning's stop matching applies. `GET /vehicle-types` lists
// them, `POST /vehicle-types` adds one, `GET`/`PATCH /vehicle-types/:id` read
// and change one, and `PUT /vehicle-types/:id/container-types` replaces the
// container types a vehicle of the type may service. No delete: a type a
// Stop Matching Rule asks for and a vehicle is bought as is quoted by rows
// that outlive it.
//
// A row and not a token of the code's, for the reason that made a waste
// fraction a row: one company's "Rear loader" is another's "Baglæsser", and a
// rule that asks for a vehicle type asks for one of this company's
// (`collection_group.rule_vehicle_type_id`). So it is master data, the
// company's and no project's, under `configure.master` like the fractions and
// the container types, and every statement carries `company_id = the
// caller's` beside the fence (ADR-0001) and nothing about a project: an
// account with the grant reads the company's types, as it reads its
// fractions.
//
// Two names, not interchangeable, as a fraction has: `key` is the slug the
// rest of the system quotes (`rear-loader`) and is set once — a patch takes
// the name and the description alone, since a rule or an import that quotes
// the old key would go on quoting it, and a type that needs another key is
// another type — and `name` is what a person reads. Both are unique per
// company, each collision with its own sentence.
//
// The container types are the set that travels with the record, in the sense
// of routes/members.ts, through the company-wide, role-less sibling in
// routes/id-sets.ts: read with the type sorted by id, a page's loaded in one
// query, a create may carry the set it starts with, a patch never touches it,
// and the PUT replaces it whole, the type's own row stamped first so
// `updatedAt` moves. Every id is a container type of this company (400 at
// `containerTypeIds.N`, the singular check's sentence), a create and the PUT
// answer the set they were given in read order rather than reading it back
// (`asRead`), and an empty set is a type no typed rule matches through — the
// prototype's "no compatibility profile → excluded with a reason", kept.
import { Page } from "@waste/contracts/pagination"
import { VehicleType, VehicleTypeContainerTypesSet, VehicleTypeCreate, VehicleTypeListQuery, VehicleTypePatch } from "@waste/contracts/vehicle-types"
import type { Tx } from "@waste/db/client"
import { containerType } from "@waste/db/schema/catalogue"
import { containerTypeVehicleType, vehicleType } from "@waste/db/schema/fleet-types"
import { and, asc, eq, gt } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { asRead, idsFor, idsOf, replaceIdSet, requireEachOf, writeIds, type IdSet } from "./id-sets"
import { requireContainerType } from "./references"
import { created, describeCreated, describeJson, IdParam, refuseDuplicate, stampsOf } from "./shared"

const MODULE = "configure.master"
const VehicleTypePage = Page(VehicleType)

const columns = {
  id: vehicleType.id,
  key: vehicleType.key,
  name: vehicleType.name,
  description: vehicleType.description,
  createdAt: vehicleType.createdAt,
  updatedAt: vehicleType.updatedAt,
}

type Row = Pick<typeof vehicleType.$inferSelect, keyof typeof columns>

/** The compatibility set: the container types of this company a vehicle of the type may service, one row per pair. */
const containerTypes: IdSet<typeof containerTypeVehicleType> = {
  table: containerTypeVehicleType,
  parentId: containerTypeVehicleType.vehicleTypeId,
  entryId: containerTypeVehicleType.containerTypeId,
  rowOf: (containerTypeId, owner) => ({ id: newId(), companyId: owner.companyId, vehicleTypeId: owner.id, containerTypeId }),
  require: requireEachOf(containerType, "containerTypeIds", requireContainerType),
}

/** The row on the wire, with the container types the page loaded for it, by id. */
function typeOf(row: Row, containerTypeIds: readonly string[]): VehicleType {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    containerTypeIds: [...containerTypeIds],
    ...stampsOf(row),
  }
}

/** One type on the wire, its set read back the way a page reads it, so an answer equals the next read. */
async function typeWithContainerTypes(tx: Tx, companyId: string, row: Row): Promise<VehicleType> {
  return typeOf(row, await idsFor(tx, containerTypes, companyId, row.id))
}

/** `unique (company_id, key)` and `unique (company_id, name)`: each is one type's inside a company, and free in the next. */
const KEY_TAKEN = "vehicle_type_key_key"
const NAME_TAKEN = "vehicle_type_name_key"
const keyTaken = (key: string) => `This company already has a vehicle type keyed ${JSON.stringify(key)}`
const nameTaken = (name: string) => `This company already has a vehicle type named ${JSON.stringify(name)}`

const noSuchType = (id: string) => problem(404, { detail: `No vehicle type ${id} in this company` })

/** The rows of this company: what every vehicle type statement is bounded by. */
const scope = (principal: Principal) => eq(vehicleType.companyId, principal.companyId)

/** One type of this company by id; undefined when there is none. */
async function findType(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(vehicleType)
    .where(and(scope(principal), eq(vehicleType.id, id)))
    .limit(1)
  return row
}

export function vehicleTypeRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/vehicle-types",
      describeRoute({
        operationId: "listVehicleTypes",
        summary: "The company's vehicle types",
        description:
          "One page of the vehicle types the company names, oldest first (ids are time-ordered), each with `containerTypeIds`, the container types a vehicle of the type may service, by id. A type is the company's vocabulary and no project's, so the page is the only parameter. Hand `nextCursor` back as `cursor` for the next page; `nextCursor` is null on the last one.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of vehicle types, each with its container types.", VehicleTypePage),
          400: describeProblem("The page size is outside 1..200, or the cursor is not one this API wrote."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `configure.master`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", VehicleTypeListQuery),
      async (c) => {
        const { limit, cursor } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        const rows = await tx
          .select(columns)
          .from(vehicleType)
          .where(and(scope(principal), after === undefined ? undefined : gt(vehicleType.id, after)))
          .orderBy(asc(vehicleType.id))
          .limit(fetchLimit(limit))
        // Paged first, so the row that only proves there is a next page is
        // not one of the types whose container types are loaded.
        const { items, nextCursor } = pageOf(rows, limit)
        const held = await idsOf(tx, containerTypes, principal.companyId, items.map((row) => row.id))
        return c.json({ items: items.map((row) => typeOf(row, held.get(row.id) ?? [])), nextCursor })
      },
    )
    .post(
      "/vehicle-types",
      describeRoute({
        operationId: "createVehicleType",
        summary: "Add a vehicle type",
        description:
          "Adds a vehicle type to the company's own vocabulary. `key` is the stable slug the rest of the system quotes (`rear-loader`) and is set once; `name` is what a person reads. Both are unique inside the company, each with its own sentence. `containerTypeIds` is the compatibility set the type starts with — the container types a vehicle of this type may service, each one of this company's (400 at `containerTypeIds.N` otherwise) and each named once — and none when absent, which is a type no typed Stop Matching Rule matches through. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The vehicle type as it was written, with its container types by id.", VehicleType),
          400: describeProblem(
            "The body is missing a field, spells the key as something other than a lowercase slug, names a member the server owns, names the same container type twice, or names a container type that is not this company's.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `configure.master`."),
          409: describeProblem("The company already has a vehicle type with that key, or with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", VehicleTypeCreate),
      async (c) => {
        const { containerTypeIds, ...values } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        await containerTypes.require(tx, principal.companyId, containerTypeIds)
        const [row] = await refuseDuplicate({ [KEY_TAKEN]: keyTaken(values.key), [NAME_TAKEN]: nameTaken(values.name) }, () =>
          tx
            .insert(vehicleType)
            .values({ ...values, id: newId(), companyId: principal.companyId })
            .returning(columns),
        )
        await writeIds(tx, containerTypes, { companyId: principal.companyId, id: row.id }, containerTypeIds)
        // The set just written is known — held to the company, each id once — so it is answered in read order and not read back.
        return created(c, "/vehicle-types", typeOf(row, asRead(containerTypeIds)))
      },
    )
    .get(
      "/vehicle-types/:id",
      describeRoute({
        operationId: "getVehicleType",
        summary: "One vehicle type",
        description:
          "One vehicle type of the caller's company, with the container types a vehicle of it may service. Another company's type is a type that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The vehicle type, with its container types by id.", VehicleType),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `configure.master`."),
          404: describeProblem("No vehicle type with that id in this company."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findType(tx, principal, id)
        if (row === undefined) throw noSuchType(id)
        return c.json(await typeWithContainerTypes(tx, principal.companyId, row))
      },
    )
    .patch(
      "/vehicle-types/:id",
      describeRoute({
        operationId: "patchVehicleType",
        summary: "Change a vehicle type",
        description:
          "Changes the name or the description of one vehicle type; every field is optional and at least one must be given, and a null clears the description. The key does not change: it is the slug a Stop Matching Rule, an import or a report quotes, and a type that needs another key is another type. The container types are a set, so they are `PUT /vehicle-types/{id}/container-types`.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The vehicle type as it now stands, with its container types.", VehicleType),
          400: describeProblem("The path does not hold an id, or the patch is empty or names a field the caller does not own (the key and the container types included)."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `configure.master`."),
          404: describeProblem("No vehicle type with that id in this company."),
          409: describeProblem("The company already has another vehicle type with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", VehicleTypePatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const sentences: Record<string, string> = patch.name === undefined ? {} : { [NAME_TAKEN]: nameTaken(patch.name) }
        const [row] = await refuseDuplicate(sentences, () =>
          tx
            .update(vehicleType)
            .set(patch)
            .where(and(scope(principal), eq(vehicleType.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchType(id)
        return c.json(await typeWithContainerTypes(tx, principal.companyId, row))
      },
    )
    .put(
      "/vehicle-types/:id/container-types",
      describeRoute({
        operationId: "putVehicleTypeContainerTypes",
        summary: "Replace a vehicle type's container types",
        description:
          "Replaces the whole compatibility set with the one in the body: a container type the body leaves out is not serviced by vehicles of this type afterwards, and an empty list is a type no typed Stop Matching Rule matches through. Every id is a container type of this company (400 at `containerTypeIds.N` otherwise), each named once (400 on `containerTypeIds`). The type's `updatedAt` moves, since the set is part of the type on the wire.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The vehicle type with the container types it now has.", VehicleType),
          400: describeProblem(
            "The path does not hold an id, or the body is missing `containerTypeIds`, names a member it does not own, names the same container type twice, or names a container type that is not this company's.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `configure.master`."),
          404: describeProblem("No vehicle type with that id in this company."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", VehicleTypeContainerTypesSet),
      async (c) => {
        const { id } = c.req.valid("param")
        const { containerTypeIds } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await replaceIdSet(tx, containerTypes, principal.companyId, containerTypeIds, (stamped) =>
          tx
            .update(vehicleType)
            .set(stamped)
            .where(and(scope(principal), eq(vehicleType.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchType(id)
        return c.json(typeOf(row, asRead(containerTypeIds)))
      },
    )
}
