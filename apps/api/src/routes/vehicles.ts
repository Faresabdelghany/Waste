// The fleet's vehicles (Issue #101, slice 4): the Vehicle with its
// compartments. `GET /vehicles` lists them, `POST /vehicles` registers one with
// the compartments it starts with, `GET`/`PATCH /vehicles/:id` read and change
// one, and `PUT /vehicles/:id/compartments` replaces the compartments whole.
// No delete: a vehicle that leaves the fleet is `status: retired`, and the
// allocations and routes behind it stay readable.
//
// A vehicle is project-scoped, so every statement carries the tenant and
// `inProjects` (auth/projects.ts): a caller reads the vehicles of the projects
// it works in, a create names one of those in the body (400 on `projectId`),
// and the project is not patchable — a record does not move between projects.
// Nor is `kind`: a powered vehicle does not become a trailer, and the
// contracts keep both off the patch.
//
// The compartments are the glossary's "one or more compartments, each with a
// capacity for one or more waste fractions", as rows: a positioned list that
// travels with the vehicle — read with it, written with it, replaced whole —
// each compartment carrying the fractions it takes. A page of vehicles costs
// three statements, never three per vehicle: the compartments of every vehicle
// on the page in one query, by position, and their fractions in one more, in
// the order they were written (ids are minted in body order, ADR-0004), then
// grouped. A single read and the answer to a write go through the same
// assembly, so what a write answers is what the next read says. The body's
// fractions are held in one statement across every compartment, the way
// routes/scheme-groups.ts holds a scheme's sets: a body naming one fraction of
// another company and a body naming one among two hundred are refused the
// same way, a 400 at `compartments.N.wasteFractionIds.M` with the sentence
// routes/references.ts spells once.
//
// `PUT …/compartments` is a sibling of routes/scheme-groups.ts's
// `replaceGroupSet` rather than a fourth descriptor for routes/members.ts:
// a compartment is a row with child rows of its own, where a membership entry
// is one row. It keeps the mechanism's steps — the vehicle's own row stamped
// first under the caller's scope (`stamp()`, which also takes its row lock
// and answers "no such vehicle"), the kind read off that row to hold "a
// powered vehicle has at least one compartment" (the contracts hold it on the
// create, where the body says the kind; here the stored kind says), the
// fractions held in one statement, then delete-then-insert inside the
// request's one transaction, fraction rows before compartment rows and
// positions 1..n in the body's order — and never a diff.
//
// Retiring is the one status change with a rule: a vehicle with a live
// allocation — `planned` or `confirmed` and not yet over — is not retired
// under it, and nor is one a collection group of a route scheme in force
// today names, whatever the scheme's status; the patch is refused (409)
// counting them, since the rows in the way are not in the body and have to
// be released, or reassigned, first (the `refuseStranded` shape of
// routes/periods.ts, the pieces spelled once in routes/statuses.ts and
// routes/scheme-groups.ts, since a driver is taken out of service the same
// way). An allocation names a vehicle as its vehicle or as its trailer, and a
// trailer is a vehicle of this table, so both columns are counted. The counts
// run under the vehicle's row lock, taken before the current row is read, so
// a retirement and an allocation being made serialise on the vehicle. The
// other half of the rule is the doors that name a vehicle afresh, which
// refuse a retired one (#79: a status gates a new reference and never an
// existing one).
//
// The provider rule — a `service-provider` vehicle names its provider and no
// other does — is the contracts' on a body that carries both halves and the
// route's on a patch that carries one, held against the merged row in the
// contracts' own words, so the database's `vehicle_provider_shape` check is
// the backstop and never the answer.
//
// The grant is `fleet.vehicles` throughout: `view` to read, `create` to add,
// `edit` to change and to replace the compartments.
import {
  A_POWERED_VEHICLE_HAS_A_COMPARTMENT,
  poweredVehicleHasACompartment,
  Vehicle,
  VehicleCompartmentsSet,
  VehicleCreate,
  VehicleListQuery,
  VehiclePatch,
  type VehicleCompartment,
  type VehicleCompartmentCreate,
} from "@waste/contracts/fleet"
import { Page } from "@waste/contracts/pagination"
import { PROVIDER_WITH_PROVIDER_OWNERSHIP } from "@waste/contracts/places"
import type { Tx } from "@waste/db/client"
import { vehicleAllocation } from "@waste/db/schema/allocations"
import { wasteFraction } from "@waste/db/schema/catalogue"
import { vehicle, vehicleCompartment, vehicleCompartmentFraction } from "@waste/db/schema/fleet"
import { collectionGroup } from "@waste/db/schema/route-schemes"
import type { FuelType, LicenceClass, VehicleKind, VehicleOwnership, VehicleStatus } from "@waste/domain/resources/vocabulary"
import { and, asc, eq, gt, inArray, or } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { refuseStranded } from "./periods"
import { requireDepot, requireServiceProvider, requireVehicleType, requireWasteFraction, type Scope } from "./references"
import { groupsInForceNaming } from "./scheme-groups"
import { describeJson, IdParam, lockRow, refuseDuplicate, requireProviderShape, stamp, stampsOf } from "./shared"
import { groupsName, liveAllocationsName, liveAllocationsNaming } from "./statuses"

const MODULE = "fleet.vehicles"
const VehiclePage = Page(Vehicle)

const columns = {
  id: vehicle.id,
  projectId: vehicle.projectId,
  registration: vehicle.registration,
  callsign: vehicle.callsign,
  kind: vehicle.kind,
  vehicleTypeId: vehicle.vehicleTypeId,
  ownership: vehicle.ownership,
  serviceProviderId: vehicle.serviceProviderId,
  status: vehicle.status,
  capacityKg: vehicle.capacityKg,
  requiredLicenceClass: vehicle.requiredLicenceClass,
  homeDepotId: vehicle.homeDepotId,
  fuel: vehicle.fuel,
  telematicsDeviceId: vehicle.telematicsDeviceId,
  notes: vehicle.notes,
  createdAt: vehicle.createdAt,
  updatedAt: vehicle.updatedAt,
}

type Row = Pick<typeof vehicle.$inferSelect, keyof typeof columns>

/** The row on the wire, with the compartments read for it. The coded fields are text with a CHECK in the database and an enum here; the vocabulary holds the two in lockstep. */
function vehicleOf(row: Row, compartments: VehicleCompartment[]): Vehicle {
  return {
    id: row.id,
    projectId: row.projectId,
    registration: row.registration,
    callsign: row.callsign,
    kind: row.kind as VehicleKind,
    vehicleTypeId: row.vehicleTypeId,
    ownership: row.ownership as VehicleOwnership,
    serviceProviderId: row.serviceProviderId,
    status: row.status as VehicleStatus,
    capacityKg: row.capacityKg,
    requiredLicenceClass: row.requiredLicenceClass as LicenceClass,
    homeDepotId: row.homeDepotId,
    fuel: row.fuel as FuelType | null,
    telematicsDeviceId: row.telematicsDeviceId,
    notes: row.notes,
    compartments,
    ...stampsOf(row),
  }
}

/**
 * The compartments of every vehicle asked for, by vehicle, in position order,
 * each with its fractions in the order they were written: two queries however
 * many vehicles the page holds. A vehicle with no compartments — a trailer —
 * is absent from the map, so a caller reads `?? []`.
 */
async function compartmentsOf(tx: Tx, companyId: string, vehicleIds: readonly string[]): Promise<Map<string, VehicleCompartment[]>> {
  const byVehicle = new Map<string, VehicleCompartment[]>()
  if (vehicleIds.length === 0) return byVehicle
  const rows = await tx
    .select({
      id: vehicleCompartment.id,
      vehicleId: vehicleCompartment.vehicleId,
      position: vehicleCompartment.position,
      name: vehicleCompartment.name,
      capacityKg: vehicleCompartment.capacityKg,
      volumeLitres: vehicleCompartment.volumeLitres,
    })
    .from(vehicleCompartment)
    .where(and(eq(vehicleCompartment.companyId, companyId), inArray(vehicleCompartment.vehicleId, [...vehicleIds])))
    .orderBy(asc(vehicleCompartment.vehicleId), asc(vehicleCompartment.position))
  if (rows.length === 0) return byVehicle
  const fractions = await tx
    .select({ compartment: vehicleCompartmentFraction.vehicleCompartmentId, wasteFractionId: vehicleCompartmentFraction.wasteFractionId })
    .from(vehicleCompartmentFraction)
    .where(
      and(
        eq(vehicleCompartmentFraction.companyId, companyId),
        inArray(
          vehicleCompartmentFraction.vehicleCompartmentId,
          rows.map((row) => row.id),
        ),
      ),
    )
    .orderBy(asc(vehicleCompartmentFraction.id))
  const byCompartment = new Map<string, string[]>()
  for (const row of fractions) {
    const found = byCompartment.get(row.compartment)
    if (found === undefined) byCompartment.set(row.compartment, [row.wasteFractionId])
    else found.push(row.wasteFractionId)
  }
  for (const row of rows) {
    const compartment: VehicleCompartment = {
      position: row.position,
      name: row.name,
      capacityKg: row.capacityKg,
      volumeLitres: row.volumeLitres,
      wasteFractionIds: byCompartment.get(row.id) ?? [],
    }
    const found = byVehicle.get(row.vehicleId)
    if (found === undefined) byVehicle.set(row.vehicleId, [compartment])
    else found.push(compartment)
  }
  return byVehicle
}

/** One vehicle on the wire, its compartments read the way a page reads them, so an answer equals the next read. */
async function vehicleWithCompartments(tx: Tx, companyId: string, row: Row): Promise<Vehicle> {
  return vehicleOf(row, (await compartmentsOf(tx, companyId, [row.id])).get(row.id) ?? [])
}

/**
 * Holds every fraction a body's compartments name to the company in one
 * statement, however many compartments and fractions there are, and hands the
 * first entry that is not there to the singular check of
 * routes/references.ts, which refuses it at the path the body spelled it —
 * so one bad id and one among two hundred are told the same thing, and the
 * one extra statement is spent on the failure path only.
 */
async function requireCompartmentFractions(tx: Tx, companyId: string, compartments: readonly VehicleCompartmentCreate[]): Promise<void> {
  const named = compartments.flatMap((compartment, n) => compartment.wasteFractionIds.map((id, m) => ({ path: `compartments.${n}.wasteFractionIds.${m}`, id })))
  const ids = [...new Set(named.map((entry) => entry.id))]
  if (ids.length === 0) return
  const rows = await tx
    .select({ id: wasteFraction.id })
    .from(wasteFraction)
    .where(and(eq(wasteFraction.companyId, companyId), inArray(wasteFraction.id, ids)))
  const found = new Set(rows.map((row) => row.id))
  const missing = named.find((entry) => !found.has(entry.id))
  if (missing !== undefined) await requireWasteFraction(tx, companyId, missing.id, missing.path)
}

/**
 * Writes a vehicle's compartments with positions 1..n in the body's order and
 * their fractions, one insert per table however many compartments there are;
 * the fraction ids are minted in body order, which is the order they read
 * back in. Nothing to write is no statement.
 */
async function writeCompartments(tx: Tx, scope: Scope, vehicleId: string, compartments: readonly VehicleCompartmentCreate[]): Promise<void> {
  if (compartments.length === 0) return
  const rows = compartments.map((compartment, index) => ({
    id: newId(),
    companyId: scope.companyId,
    projectId: scope.projectId,
    vehicleId,
    position: index + 1,
    name: compartment.name ?? null,
    capacityKg: compartment.capacityKg ?? null,
    volumeLitres: compartment.volumeLitres ?? null,
  }))
  await tx.insert(vehicleCompartment).values(rows)
  const fractions = rows.flatMap((row, index) =>
    compartments[index].wasteFractionIds.map((wasteFractionId) => ({
      id: newId(),
      companyId: scope.companyId,
      projectId: scope.projectId,
      vehicleCompartmentId: row.id,
      wasteFractionId,
    })),
  )
  if (fractions.length > 0) await tx.insert(vehicleCompartmentFraction).values(fractions)
}

/** What a body without a compartment for a powered vehicle is told, at the list: the contracts' sentence, held here against the stored kind. */
function requireCompartmentsFor(kind: string, compartments: readonly unknown[]): void {
  if (poweredVehicleHasACompartment(kind, compartments)) return
  throw invalidRequest("body", [{ path: "compartments", message: A_POWERED_VEHICLE_HAS_A_COMPARTMENT }])
}

/**
 * `PUT /vehicles/:id/compartments`: the vehicle's own row first — the stamp,
 * under the caller's scope, which takes the row lock and answers "no such
 * vehicle" — then the stored kind holds the list to the powered-vehicle rule,
 * the fractions are held to the company, and the set is replaced whole:
 * fraction rows, compartment rows, then the body's, all in the request's one
 * transaction, so a refused body leaves the vehicle exactly as it was, stamp
 * included.
 */
async function replaceCompartments(tx: Tx, principal: Principal, id: string, compartments: readonly VehicleCompartmentCreate[]): Promise<Row | undefined> {
  const [row] = await tx
    .update(vehicle)
    .set(stamp())
    .where(and(scope(principal), eq(vehicle.id, id)))
    .returning(columns)
  if (row === undefined) return undefined
  requireCompartmentsFor(row.kind, compartments)
  await requireCompartmentFractions(tx, principal.companyId, compartments)
  const mine = tx
    .select({ id: vehicleCompartment.id })
    .from(vehicleCompartment)
    .where(and(eq(vehicleCompartment.companyId, principal.companyId), eq(vehicleCompartment.vehicleId, id)))
  await tx
    .delete(vehicleCompartmentFraction)
    .where(and(eq(vehicleCompartmentFraction.companyId, principal.companyId), inArray(vehicleCompartmentFraction.vehicleCompartmentId, mine)))
  await tx.delete(vehicleCompartment).where(and(eq(vehicleCompartment.companyId, principal.companyId), eq(vehicleCompartment.vehicleId, id)))
  await writeCompartments(tx, { companyId: principal.companyId, projectId: row.projectId }, id, compartments)
  return row
}

/** `unique (company_id, registration)`: a plate is one vehicle's anywhere in the company. */
const REGISTRATION_TAKEN = "vehicle_registration_key"
const registrationTaken = (registration: string) => `This company already has a vehicle registered ${registration}`

/** The partial unique index `(company_id, callsign) where callsign is not null`, which Postgres names as the constraint it refused with. */
const CALLSIGN_TAKEN = "vehicle_callsign_idx"
const callsignTaken = (callsign: string) => `This company already has a vehicle with the callsign ${callsign}`

/** The sentences a write here can earn, and only for the fields the body gave. */
const collisions = (values: { registration?: string; callsign?: string | null }): Record<string, string> => ({
  ...(values.registration === undefined ? {} : { [REGISTRATION_TAKEN]: registrationTaken(values.registration) }),
  ...(values.callsign == null ? {} : { [CALLSIGN_TAKEN]: callsignTaken(values.callsign) }),
})

const noSuchVehicle = (id: string) => problem(404, { detail: `No vehicle ${id} in the projects this account works in` })

/** What a retirement under live allocations, or under the collection groups of schemes in force, is refused with, counting them. */
const liveAllocationsNameThis = liveAllocationsName("vehicle")
const groupsNameThis = groupsName("vehicle")

/** The allocations a retirement would strand: the live ones naming the vehicle as the vehicle or as the trailer (routes/statuses.ts spells the rest). */
const liveAllocations = (companyId: string, vehicleId: string) =>
  liveAllocationsNaming(companyId, or(eq(vehicleAllocation.vehicleId, vehicleId), eq(vehicleAllocation.trailerId, vehicleId)))

/** The rows of this company, in the projects the caller works in: what every vehicle statement is bounded by. */
const scope = (principal: Principal) => and(eq(vehicle.companyId, principal.companyId), inProjects(vehicle.projectId, principal))

/** One vehicle of this company by id, inside the caller's projects; undefined when it is neither. */
async function findVehicle(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(vehicle)
    .where(and(scope(principal), eq(vehicle.id, id)))
    .limit(1)
  return row
}

export function vehicleRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/vehicles",
      describeRoute({
        operationId: "listVehicles",
        summary: "The vehicles the caller's projects run",
        description:
          "One page of vehicles, oldest first (ids are time-ordered), from the projects the caller works in — an account that works in none, such as a service provider's, reads an empty page — each with its compartments by position and each compartment's waste fractions. `projectId` narrows it to one of those projects; naming another is refused. `kind` answers the powered vehicles or the trailers, `vehicleTypeId` one type's, `status` one status, `homeDepotId` the vehicles based at one depot. The filters combine. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of vehicles, each with its compartments.", VehiclePage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a filter is malformed, or `projectId` is not a project this account works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `fleet.vehicles`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", VehicleListQuery),
      async (c) => {
        const { limit, cursor, projectId, kind, vehicleTypeId, status, homeDepotId } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await tx
          .select(columns)
          .from(vehicle)
          .where(
            and(
              scope(principal),
              projectId === undefined ? undefined : eq(vehicle.projectId, projectId),
              kind === undefined ? undefined : eq(vehicle.kind, kind),
              vehicleTypeId === undefined ? undefined : eq(vehicle.vehicleTypeId, vehicleTypeId),
              status === undefined ? undefined : eq(vehicle.status, status),
              homeDepotId === undefined ? undefined : eq(vehicle.homeDepotId, homeDepotId),
              after === undefined ? undefined : gt(vehicle.id, after),
            ),
          )
          .orderBy(asc(vehicle.id))
          .limit(fetchLimit(limit))
        // Paged first, so the row that only proves there is a next page is not one whose compartments are loaded.
        const { items, nextCursor } = pageOf(rows, limit)
        const compartments = await compartmentsOf(tx, principal.companyId, items.map((row) => row.id))
        return c.json({ items: items.map((row) => vehicleOf(row, compartments.get(row.id) ?? [])), nextCursor })
      },
    )
    .post(
      "/vehicles",
      describeRoute({
        operationId: "createVehicle",
        summary: "Register a vehicle with its compartments",
        description:
          "Registers a vehicle in one project, which must be a project the caller works in, with the compartments it starts with in position order, 1..n in the body's order — a powered vehicle has at least one, a trailer may have none. The registration (the plate) is unique across the company, not inside a project, and so is the callsign where given. The vehicle type is one of this company's, the home depot one of the named project's, the owning service provider one of this company's and named with `service-provider` ownership and with nothing else, and every compartment's waste fractions are this company's, each named once per compartment. `ownership` defaults to `company` and `status` to `active`. `requiredLicenceClass` is required: an unknown class passes nobody, so a vehicle without one is a vehicle nobody may take out. The server mints every id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeJson("The vehicle as it was written, with its compartments.", Vehicle),
          400: describeProblem(
            "The body is missing a field, names a member the server owns, names a project this account does not work in, gives a powered vehicle no compartment, names a fraction twice in one compartment, names the provider without service-provider ownership or the ownership without a provider, or names a vehicle type, service provider, depot or waste fraction outside the scope its key allows — each at the entry that is wrong.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `fleet.vehicles`."),
          409: describeProblem("The company already has a vehicle with that registration, or one with that callsign."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", VehicleCreate),
      async (c) => {
        const { compartments, ...values } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, values.projectId)
        const within: Scope = { companyId: principal.companyId, projectId: values.projectId }

        // The 400s first, each at its field, in the order a body reads.
        await requireVehicleType(tx, principal.companyId, values.vehicleTypeId)
        await requireServiceProvider(tx, principal.companyId, values.serviceProviderId)
        await requireDepot(tx, within, values.homeDepotId, "homeDepotId")
        await requireCompartmentFractions(tx, principal.companyId, compartments)

        const [row] = await refuseDuplicate(collisions(values), () =>
          tx
            .insert(vehicle)
            .values({
              ...values,
              id: newId(),
              companyId: principal.companyId,
              callsign: values.callsign ?? null,
              serviceProviderId: values.serviceProviderId ?? null,
              capacityKg: values.capacityKg ?? null,
              homeDepotId: values.homeDepotId ?? null,
              fuel: values.fuel ?? null,
              telematicsDeviceId: values.telematicsDeviceId ?? null,
              notes: values.notes ?? null,
            })
            .returning(columns),
        )
        await writeCompartments(tx, within, row.id, compartments)
        return c.json(await vehicleWithCompartments(tx, principal.companyId, row), 201)
      },
    )
    .get(
      "/vehicles/:id",
      describeRoute({
        operationId: "getVehicle",
        summary: "One vehicle",
        description:
          "One vehicle of a project the caller works in, with its compartments by position and each compartment's waste fractions. A vehicle of another company, or of a project this account does not work in, is a vehicle that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The vehicle, with its compartments.", Vehicle),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `fleet.vehicles`."),
          404: describeProblem("No vehicle with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findVehicle(tx, principal, id)
        if (row === undefined) throw noSuchVehicle(id)
        return c.json(await vehicleWithCompartments(tx, principal.companyId, row))
      },
    )
    .patch(
      "/vehicles/:id",
      describeRoute({
        operationId: "patchVehicle",
        summary: "Change a vehicle",
        description:
          "Changes one vehicle of a project the caller works in; every field is optional and at least one must be given. The project and the kind do not change — a record does not move between projects, and a powered vehicle does not become a trailer — and the compartments are a set, so they are `PUT /vehicles/{id}/compartments`. A null clears the callsign, the provider, the payload, the home depot, the fuel, the telematics device or the notes. The provider rule is held against the row the patch leaves behind: a `service-provider` vehicle names its provider and no other does. A new vehicle type is this company's, a new home depot this project's, a new provider this company's. A status change is a plain patch except retiring: a vehicle with a live allocation — planned or confirmed and not yet over, naming it as the vehicle or as the trailer — is not retired under it, nor is one a collection group of a route scheme in force today names, whatever that scheme's status; the patch is refused (409) counting them — release the allocations, reassign the groups, and retire it then. Both counts run under the vehicle's row lock, and a vehicle already retired is not asked again.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The vehicle as it now stands, with its compartments.", Vehicle),
          400: describeProblem(
            "The path does not hold an id, or the patch is empty, names a field the caller does not own (the project, the kind and the compartments included), leaves the ownership and the provider disagreeing, or names a vehicle type, service provider or depot outside the scope its key allows.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `fleet.vehicles`."),
          404: describeProblem("No vehicle with that id in the projects this account works in."),
          409: describeProblem("The company already has another vehicle with that registration or that callsign, or the vehicle is being retired under live allocations or under collection groups of schemes in force: the detail counts them."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", VehiclePatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        // The row every rule below is held against, locked before it is read
        // (routes/shared.ts): a retirement and an allocation being made are two
        // halves of one rule, and they serialise here.
        await lockRow(tx, vehicle, { companyId: principal.companyId, id })
        const current = await findVehicle(tx, principal, id)
        if (current === undefined) throw noSuchVehicle(id)
        const within: Scope = { companyId: principal.companyId, projectId: current.projectId }
        const merged = { ...current, ...patch }

        // The provider rule as the merged row must hold it (routes/shared.ts): a patch carries one half and the stored row the other.
        requireProviderShape(merged.ownership, merged, PROVIDER_WITH_PROVIDER_OWNERSHIP)
        await requireVehicleType(tx, principal.companyId, patch.vehicleTypeId)
        await requireServiceProvider(tx, principal.companyId, patch.serviceProviderId)
        await requireDepot(tx, within, patch.homeDepotId, "homeDepotId")
        if (patch.status === "retired" && current.status !== "retired") {
          await refuseStranded(tx, vehicleAllocation, liveAllocations(principal.companyId, id), liveAllocationsNameThis)
          await refuseStranded(tx, collectionGroup, groupsInForceNaming(tx, collectionGroup.vehicleId, principal.companyId, id), groupsNameThis)
        }

        const [row] = await refuseDuplicate(collisions(patch), () =>
          tx
            .update(vehicle)
            .set(patch)
            .where(and(scope(principal), eq(vehicle.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchVehicle(id)
        return c.json(await vehicleWithCompartments(tx, principal.companyId, row))
      },
    )
    .put(
      "/vehicles/:id/compartments",
      describeRoute({
        operationId: "putVehicleCompartments",
        summary: "Replace a vehicle's compartments",
        description:
          "Replaces the whole list with the one in the body, in position order: a compartment the body leaves out is not a compartment afterwards, positions are 1..n in the body's order, and each compartment's waste fractions are this company's, each named once per compartment. A powered vehicle keeps at least one compartment, so an empty list is refused for one and is a bare trailer for the other; the stored kind decides. The list is replaced under the vehicle's row lock, and the vehicle's `updatedAt` moves, since the compartments are part of the vehicle on the wire.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The vehicle with the compartments it now has.", Vehicle),
          400: describeProblem(
            "The path does not hold an id, or the body is missing `compartments`, names a member it does not own, is over twenty compartments, leaves a powered vehicle without one, names a fraction twice in one compartment, or names a waste fraction that is not this company's — at the entry that is wrong.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `fleet.vehicles`."),
          404: describeProblem("No vehicle with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", VehicleCompartmentsSet),
      async (c) => {
        const { id } = c.req.valid("param")
        const { compartments } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await replaceCompartments(tx, principal, id, compartments)
        if (row === undefined) throw noSuchVehicle(id)
        return c.json(await vehicleWithCompartments(tx, principal.companyId, row))
      },
    )
}
