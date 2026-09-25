// The fleet's drivers (Issue #101, slice 4): the Driver, "a workforce profile
// linked to a User identity", never the same record. `GET /drivers` lists
// them, `POST /drivers` registers one, `GET`/`PATCH /drivers/:id` read and
// change one. No delete: a driver who leaves is `status: inactive`, and the
// allocations and routes behind them stay readable.
//
// A driver is project-scoped, so every statement carries the tenant and
// `inProjects` (auth/projects.ts): a caller reads the drivers of the projects
// it works in, a create names one of those in the body (400 on `projectId`),
// and the project is not patchable — a record does not move between projects.
//
// The login is `userAccountId`, a user account of this company that is not
// deactivated (400 "Not a user account of this company" otherwise), and one
// profile per login: the partial unique index answers a second profile on the
// same account with a 409 sentence, as the workforce reference — the payroll
// system's, unique per company where given — answers a second driver with the
// same one. The licence is three attributes and not a period (ADR-0005: a
// renewal is an edit): the class is a vocabulary token, null being "not on
// record" and eligible for nothing, the expiry a `YYYY-MM-DD` day, and whether
// a driver may take a vehicle on a day is @waste/domain/resources/licence's
// question, asked by the allocation and the collection group routes (slice 6)
// and never here.
//
// The provider rule — a `service-provider` driver names the employing provider
// and no other does — is the contracts' on a body that carries both halves
// and the route's on a patch that carries one, held against the merged row in
// the contracts' own words for a driver (`PROVIDER_WITH_PROVIDER_EMPLOYMENT`),
// so the database's `driver_provider_shape` check is the backstop and never
// the answer.
//
// Taking a driver out of service — `inactive` or `suspended`, the two statuses
// nothing may be planned or allocated under — has the vehicle's retirement
// rule (routes/vehicles.ts): a driver a live allocation still names, or a
// collection group of a route scheme in force today, is not set either under
// it, and the patch is refused (409) counting them, since the rows in the way
// are not in the body and have to be released, or reassigned, first. The
// counts run under the driver's row lock, and a driver already out of service
// is not asked again when moved between the two. The other half is the doors
// that name a driver afresh, which refuse one who is not active
// (routes/statuses.ts; #79: a status gates a new reference and never an
// existing one).
//
// The grant is `fleet.drivers` throughout: `view` to read, `create` to add,
// `edit` to change.
import { Driver, DriverCreate, DriverListQuery, DriverPatch, PROVIDER_WITH_PROVIDER_EMPLOYMENT } from "@waste/contracts/fleet"
import { Page } from "@waste/contracts/pagination"
import type { Tx } from "@waste/db/client"
import { vehicleAllocation } from "@waste/db/schema/allocations"
import { driver } from "@waste/db/schema/fleet"
import { collectionGroup } from "@waste/db/schema/route-schemes"
import type { DriverStatus, EmploymentType, LicenceClass } from "@waste/domain/resources/vocabulary"
import { and, asc, eq, gt } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { refuseStranded } from "./periods"
import { requireDepot, requireServiceProvider, requireUserAccount, type Scope } from "./references"
import { groupsInForceNaming } from "./scheme-groups"
import { created, describeCreated, describeJson, IdParam, lockRow, refuseDuplicate, requireProviderShape, stampsOf } from "./shared"
import { groupsName, liveAllocationsName, liveAllocationsNaming } from "./statuses"

const MODULE = "fleet.drivers"
const DriverPage = Page(Driver)

const columns = {
  id: driver.id,
  projectId: driver.projectId,
  name: driver.name,
  workforceReference: driver.workforceReference,
  employment: driver.employment,
  serviceProviderId: driver.serviceProviderId,
  homeDepotId: driver.homeDepotId,
  licenceClass: driver.licenceClass,
  licenceNumber: driver.licenceNumber,
  licenceExpiry: driver.licenceExpiry,
  userAccountId: driver.userAccountId,
  status: driver.status,
  notes: driver.notes,
  createdAt: driver.createdAt,
  updatedAt: driver.updatedAt,
}

type Row = Pick<typeof driver.$inferSelect, keyof typeof columns>

/** The row on the wire. The coded fields are text with a CHECK in the database and an enum here; the vocabulary holds the two in lockstep. */
function driverOf(row: Row): Driver {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    workforceReference: row.workforceReference,
    employment: row.employment as EmploymentType,
    serviceProviderId: row.serviceProviderId,
    homeDepotId: row.homeDepotId,
    licenceClass: row.licenceClass as LicenceClass | null,
    licenceNumber: row.licenceNumber,
    licenceExpiry: row.licenceExpiry,
    userAccountId: row.userAccountId,
    status: row.status as DriverStatus,
    notes: row.notes,
    ...stampsOf(row),
  }
}

/** The partial unique index `(company_id, workforce_reference) where … is not null`, which Postgres names as the constraint it refused with. */
const WORKFORCE_REFERENCE_TAKEN = "driver_workforce_reference_idx"
const workforceReferenceTaken = (reference: string) => `This company already has a driver with the workforce reference ${reference}`

/** The partial unique index `(company_id, user_account_id) where … is not null`: one profile per login. */
const LOGIN_TAKEN = "driver_user_account_id_idx"
export const LOGIN_TAKEN_SENTENCE = "That login already has a driver profile"

/** The sentences a write here can earn, and only for the fields the body gave. */
const collisions = (values: { workforceReference?: string | null; userAccountId?: string | null }): Record<string, string> => ({
  ...(values.workforceReference == null ? {} : { [WORKFORCE_REFERENCE_TAKEN]: workforceReferenceTaken(values.workforceReference) }),
  ...(values.userAccountId == null ? {} : { [LOGIN_TAKEN]: LOGIN_TAKEN_SENTENCE }),
})

const noSuchDriver = (id: string) => problem(404, { detail: `No driver ${id} in the projects this account works in` })

/** The two statuses a driver is taken out of service with: nothing may be planned or allocated under either, so both have the same rule. */
const OUT_OF_SERVICE: readonly string[] = ["inactive", "suspended"]

/** What taking a driver out of service under live allocations, or under the collection groups of schemes in force, is refused with, counting them. */
const liveAllocationsNameThis = liveAllocationsName("driver")
const groupsNameThis = groupsName("driver")

/** The allocations the change would strand: the live ones naming the driver (routes/statuses.ts spells the rest). */
const liveAllocations = (companyId: string, driverId: string) => liveAllocationsNaming(companyId, eq(vehicleAllocation.driverId, driverId))

/** The rows of this company, in the projects the caller works in: what every driver statement is bounded by. */
const scope = (principal: Principal) => and(eq(driver.companyId, principal.companyId), inProjects(driver.projectId, principal))

/** One driver of this company by id, inside the caller's projects; undefined when it is neither. */
async function findDriver(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(driver)
    .where(and(scope(principal), eq(driver.id, id)))
    .limit(1)
  return row
}

export function driverRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/drivers",
      describeRoute({
        operationId: "listDrivers",
        summary: "The drivers the caller's projects employ",
        description:
          "One page of drivers, oldest first (ids are time-ordered), from the projects the caller works in — an account that works in none, such as a service provider's, reads an empty page. `projectId` narrows it to one of those projects; naming another is refused. `status` answers one status, `licenceClass` the drivers holding exactly that class (not the ones whose class covers it: that is the licence rule's question, asked when a vehicle is named), `homeDepotId` the drivers based at one depot. The filters combine. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of drivers.", DriverPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a filter is malformed, or `projectId` is not a project this account works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `fleet.drivers`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", DriverListQuery),
      async (c) => {
        const { limit, cursor, projectId, status, licenceClass, homeDepotId } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await tx
          .select(columns)
          .from(driver)
          .where(
            and(
              scope(principal),
              projectId === undefined ? undefined : eq(driver.projectId, projectId),
              status === undefined ? undefined : eq(driver.status, status),
              licenceClass === undefined ? undefined : eq(driver.licenceClass, licenceClass),
              homeDepotId === undefined ? undefined : eq(driver.homeDepotId, homeDepotId),
              after === undefined ? undefined : gt(driver.id, after),
            ),
          )
          .orderBy(asc(driver.id))
          .limit(fetchLimit(limit))
        const { items, nextCursor } = pageOf(rows, limit)
        return c.json({ items: items.map(driverOf), nextCursor })
      },
    )
    .post(
      "/drivers",
      describeRoute({
        operationId: "createDriver",
        summary: "Register a driver",
        description:
          "Registers a workforce profile in one project, which must be a project the caller works in. The workforce reference, where given, is unique across the company; the login (`userAccountId`), where given, is a user account of this company that is not deactivated, and one account is the login of at most one driver. The employing service provider is this company's and is named with `service-provider` employment and with nothing else; the home depot is the named project's. The licence is three attributes: the class held (`b`, `c` or `ce`; null is not on record, which is eligible for nothing), the number, and the expiry as the last day it holds — whether a driver may take a vehicle on a day is judged where a vehicle is named, never here. `status` defaults to `active`. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The driver as it was written.", Driver),
          400: describeProblem(
            "The body is missing a field, names a member the server owns, names a project this account does not work in, gives a class outside `b`, `c`, `ce` or an expiry that is not a calendar day, names the provider without service-provider employment or the employment without a provider, or names a service provider, depot or user account outside the scope its key allows — each at the field that is wrong.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `fleet.drivers`."),
          409: describeProblem("The company already has a driver with that workforce reference, or that login already has a driver profile."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", DriverCreate),
      async (c) => {
        const values = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, values.projectId)
        const within: Scope = { companyId: principal.companyId, projectId: values.projectId }

        // The 400s first, each at its field, in the order a body reads.
        await requireServiceProvider(tx, principal.companyId, values.serviceProviderId)
        await requireDepot(tx, within, values.homeDepotId, "homeDepotId")
        await requireUserAccount(tx, principal.companyId, values.userAccountId)

        const [row] = await refuseDuplicate(collisions(values), () =>
          tx
            .insert(driver)
            .values({
              ...values,
              id: newId(),
              companyId: principal.companyId,
              workforceReference: values.workforceReference ?? null,
              serviceProviderId: values.serviceProviderId ?? null,
              homeDepotId: values.homeDepotId ?? null,
              licenceClass: values.licenceClass ?? null,
              licenceNumber: values.licenceNumber ?? null,
              licenceExpiry: values.licenceExpiry ?? null,
              userAccountId: values.userAccountId ?? null,
              notes: values.notes ?? null,
            })
            .returning(columns),
        )
        return created(c, "/drivers", driverOf(row))
      },
    )
    .get(
      "/drivers/:id",
      describeRoute({
        operationId: "getDriver",
        summary: "One driver",
        description: "One driver of a project the caller works in. A driver of another company, or of a project this account does not work in, is a driver that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The driver.", Driver),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `fleet.drivers`."),
          404: describeProblem("No driver with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findDriver(tx, principal, id)
        if (row === undefined) throw noSuchDriver(id)
        return c.json(driverOf(row))
      },
    )
    .patch(
      "/drivers/:id",
      describeRoute({
        operationId: "patchDriver",
        summary: "Change a driver",
        description:
          "Changes one driver of a project the caller works in; every field is optional and at least one must be given. The project is not patchable, since a record does not move between projects. A null clears the workforce reference, the provider, the home depot, the licence class, number or expiry, the login or the notes. The provider rule is held against the row the patch leaves behind: a `service-provider` driver names the employing provider and no other does. A new provider is this company's, a new home depot this project's, a new login a user account of this company that is not deactivated and not already another driver's. A licence renewal is an edit here — the class and the expiry move — and the audit log is its history. A status change is a plain patch except taking the driver out of service: `inactive` or `suspended` under a live allocation — planned or confirmed and not yet over — or under a collection group of a route scheme in force today, whatever that scheme's status, is refused (409) counting them — release the allocations, reassign the groups, and set it then. Both counts run under the driver's row lock, and a driver already inactive or suspended is not asked again when moved to the other.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The driver as it now stands.", Driver),
          400: describeProblem(
            "The path does not hold an id, or the patch is empty, names a field the caller does not own (the project included), gives a class outside `b`, `c`, `ce` or an expiry that is not a calendar day, leaves the employment and the provider disagreeing, or names a service provider, depot or user account outside the scope its key allows.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `fleet.drivers`."),
          404: describeProblem("No driver with that id in the projects this account works in."),
          409: describeProblem(
            "The company already has another driver with that workforce reference, that login already has a driver profile, or the driver is being set inactive or suspended under live allocations or under collection groups of schemes in force: the detail counts them.",
          ),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", DriverPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        // The row the provider rule is held against, locked before it is read
        // (routes/shared.ts), so two patches that each hold alone cannot
        // together leave the row the database's check would refuse.
        await lockRow(tx, driver, { companyId: principal.companyId, id })
        const current = await findDriver(tx, principal, id)
        if (current === undefined) throw noSuchDriver(id)
        const within: Scope = { companyId: principal.companyId, projectId: current.projectId }
        const merged = { ...current, ...patch }

        // The provider rule as the merged row must hold it (routes/shared.ts), in the driver's words: a patch carries one half and the stored row the other.
        requireProviderShape(merged.employment, merged, PROVIDER_WITH_PROVIDER_EMPLOYMENT)
        await requireServiceProvider(tx, principal.companyId, patch.serviceProviderId)
        await requireDepot(tx, within, patch.homeDepotId, "homeDepotId")
        await requireUserAccount(tx, principal.companyId, patch.userAccountId)
        if (patch.status !== undefined && OUT_OF_SERVICE.includes(patch.status) && !OUT_OF_SERVICE.includes(current.status)) {
          await refuseStranded(tx, vehicleAllocation, liveAllocations(principal.companyId, id), liveAllocationsNameThis)
          await refuseStranded(tx, collectionGroup, groupsInForceNaming(tx, collectionGroup.driverId, principal.companyId, id), groupsNameThis)
        }

        const [row] = await refuseDuplicate(collisions(patch), () =>
          tx
            .update(driver)
            .set(patch)
            .where(and(scope(principal), eq(driver.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchDriver(id)
        return c.json(driverOf(row))
      },
    )
}

// Execution, slice 4 (Issue #104): the driver door's `GET /driver/me` answers the caller's own profile in this same shape, so the columns and the mapper are read from here rather than spelled again.
export { columns as driverColumns, driverOf }
