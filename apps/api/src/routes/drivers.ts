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
// A Service Provider's account works in no project and keeps its own drivers
// (#291 slice 23b, auth/provider.ts's `reachesFleet`): every statement carries
// the tenant and the drivers its provider employs, wherever they are based; a
// create names a project its provider holds a Service Area in today, its
// employment and provider are its own (`requireOwnFleet`), and the login it
// binds is an account of its own team (`requireProviderAccount`) — each a 400
// at its field, on a patch too.
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
// (@waste/domain/status-gates; #79: a status gates a new reference and never an
// existing one).
//
// The grant is `fleet.drivers` throughout: `view` to read, `create` to add,
// `edit` to change.
import { Driver, DriverCreate, DriverListQuery, DriverPatch } from "@waste/contracts/fleet"
import { Page } from "@waste/contracts/pagination"
import type { Tx } from "@waste/db/client"
import { shiftColumns, shiftOf } from "@waste/db/commands/stop-timing"
import { vehicleAllocation } from "@waste/db/schema/allocations"
import { driver } from "@waste/db/schema/fleet"
import { collectionGroup } from "@waste/db/schema/route-schemes"
import { liveAllocationsName } from "@waste/domain/resources/allocations"
import { groupsName, PROVIDER_WITH_PROVIDER_EMPLOYMENT } from "@waste/domain/resources/fleet"
import { and, eq } from "drizzle-orm"
import { newId } from "@waste/db/ids"
import { refuseDuplicate } from "@waste/db/commands/shared"
import { stampsOf } from "@waste/db/shapes/times"
import { refuseStranded } from "@waste/db/commands/periods"

import type { Principal } from "../auth/principal"
import { providerIdOf, providerNameOf, reachesFleet, requireOwnFleet, requireReachedProject } from "../auth/provider"
import type { RouteDeps } from "../deps"
import { created, describeCreated, describeJson, IdParam, routes } from "../operation"
import { pageAt } from "../pagination"
import { describeProblem } from "../problem"
import { scoped } from "../scoped"
import { requireProviderShape } from "./provider-shape"
import { requireDepot, requireProviderAccount, requireServiceProvider, requireUserAccount, type Scope } from "./references"
import { groupsInForceNaming } from "./scheme-groups"
import { shiftValues } from "./time-windows"
import { liveAllocationsNaming } from "./vehicle-allocations"

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
  ...shiftColumns,
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
    employment: row.employment,
    serviceProviderId: row.serviceProviderId,
    homeDepotId: row.homeDepotId,
    licenceClass: row.licenceClass,
    licenceNumber: row.licenceNumber,
    licenceExpiry: row.licenceExpiry,
    userAccountId: row.userAccountId,
    status: row.status,
    notes: row.notes,
    shift: shiftOf(row),
    ...stampsOf(row),
  }
}

/** The partial unique index `(company_id, workforce_reference) where … is not null`, which Postgres names as the constraint it refused with. */
const WORKFORCE_REFERENCE_TAKEN = "driver_workforce_reference_idx"
const workforceReferenceTaken = (reference: string) => `This company already has a driver with the workforce reference ${reference}`

/** The partial unique index `(company_id, user_account_id) where … is not null`: one profile per login. */
const LOGIN_TAKEN = "driver_user_account_id_idx"
export const LOGIN_TAKEN_SENTENCE = "That login already has a driver profile"

const collisions = (values: { workforceReference?: string | null; userAccountId?: string | null }): Record<string, string> => ({
  ...(values.workforceReference == null ? {} : { [WORKFORCE_REFERENCE_TAKEN]: workforceReferenceTaken(values.workforceReference) }),
  ...(values.userAccountId == null ? {} : { [LOGIN_TAKEN]: LOGIN_TAKEN_SENTENCE }),
})

/** The two statuses a driver is taken out of service with: nothing may be planned or allocated under either, so both have the same rule. */
const OUT_OF_SERVICE: readonly string[] = ["inactive", "suspended"]

/** What taking a driver out of service under live allocations, or under the collection groups of schemes in force, is refused with, counting them. */
const liveAllocationsNameThis = liveAllocationsName("driver")
const groupsNameThis = groupsName("driver")

/** The allocations the change would strand: the live ones naming the driver (@waste/domain/status-gates spells the rest). */
const liveAllocations = (companyId: string, driverId: string, now: Date) => liveAllocationsNaming(companyId, eq(vehicleAllocation.driverId, driverId), now)

const { scope, noSuch: noSuchDriver, get: getDriver, locked: lockedDriver, list: listDrivers } = scoped(driver, { noun: "driver", reach: (principal) => reachesFleet(principal, driver), columns })

/** The login a body names: any account of the company for the office, an account of its own team for a provider's (#291 slice 23b). */
async function requireLogin(tx: Tx, principal: Principal, id: string | null | undefined): Promise<void> {
  const providerId = providerIdOf(principal)
  if (providerId === null) return await requireUserAccount(tx, principal.companyId, id)
  await requireProviderAccount(tx, { companyId: principal.companyId, serviceProviderId: providerId, provider: providerNameOf(principal) }, id)
}

// The writes the routes and the fleet's CSV import (routes/import-rows.ts,
// O30 of #290) share, so an imported row is held to every rule a form's is and
// refused in the same sentence.

export async function createDriver(tx: Tx, principal: Principal, body: DriverCreate, now: () => Date): Promise<Driver> {
  const { shift, ...values } = body
  await requireReachedProject(tx, principal, values.projectId, now)
  requireOwnFleet(principal, { kind: values.employment, serviceProviderId: values.serviceProviderId }, "driver", "create")
  const within: Scope = { companyId: principal.companyId, projectId: values.projectId }

  // The 400s first, each at its field, in the order a body reads.
  await requireServiceProvider(tx, principal.companyId, values.serviceProviderId)
  await requireDepot(tx, within, values.homeDepotId, "homeDepotId")
  await requireLogin(tx, principal, values.userAccountId)

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
        ...shiftValues(shift),
      })
      .returning(columns),
  )
  return driverOf(row)
}

export async function patchDriver(tx: Tx, principal: Principal, id: string, body: DriverPatch, now: () => Date): Promise<Driver> {
  const { shift, ...patch } = body
  // The row the provider rule is held against, locked before it is read
  // (`@waste/db/commands/shared`), so two patches that each hold alone cannot
  // together leave the row the database's check would refuse.
  const current = await lockedDriver(tx, principal, id)
  const within: Scope = { companyId: principal.companyId, projectId: current.projectId }
  const merged = { ...current, ...patch }

  // A provider's own driver stays its own; then the provider rule as the merged row must hold it (routes/provider-shape.ts), in the driver's words: a patch carries one half and the stored row the other.
  requireOwnFleet(principal, { kind: patch.employment, serviceProviderId: patch.serviceProviderId }, "driver", "patch")
  requireProviderShape(merged.employment, merged, PROVIDER_WITH_PROVIDER_EMPLOYMENT)
  await requireServiceProvider(tx, principal.companyId, patch.serviceProviderId)
  await requireDepot(tx, within, patch.homeDepotId, "homeDepotId")
  await requireLogin(tx, principal, patch.userAccountId)
  if (patch.status !== undefined && OUT_OF_SERVICE.includes(patch.status) && !OUT_OF_SERVICE.includes(current.status)) {
    await refuseStranded(tx, vehicleAllocation, liveAllocations(principal.companyId, id, now()), liveAllocationsNameThis)
    await refuseStranded(tx, collectionGroup, groupsInForceNaming(tx, collectionGroup.driverId, principal.companyId, id, now()), groupsNameThis)
  }

  const [row] = await refuseDuplicate(collisions(patch), () =>
    tx
      .update(driver)
      .set({ ...patch, ...shiftValues(shift) })
      .where(and(scope(principal), eq(driver.id, id)))
      .returning(columns),
  )
  if (row === undefined) throw noSuchDriver(id)
  return driverOf(row)
}

/** The company's driver with this workforce reference, wherever they are based; undefined where there is none. */
export async function driverByWorkforceReference(tx: Tx, companyId: string, reference: string): Promise<Driver | undefined> {
  const [row] = await tx
    .select(columns)
    .from(driver)
    .where(and(eq(driver.companyId, companyId), eq(driver.workforceReference, reference)))
    .limit(1)
  return row === undefined ? undefined : driverOf(row)
}

export function driverRoutes(deps: RouteDeps) {
  const { now } = deps
  return routes(deps)
    .get(
      "/drivers",
      {
        operationId: "listDrivers",
        summary: "The drivers the caller's projects employ",
        description:
          "One page of drivers, oldest first (ids are time-ordered), from the projects the caller works in — or, for a Service Provider's account, which works in none, the drivers its provider employs, wherever they are based. `projectId` narrows it to one of those projects, or for a provider's account to a project its provider holds a Service Area in today; naming another is refused. `status` answers one status, `licenceClass` the drivers holding exactly that class (not the ones whose class covers it: that is the licence rule's question, asked when a vehicle is named), `homeDepotId` the drivers based at one depot. The filters combine. Hand `nextCursor` back as `cursor` for the next page.",
        module: MODULE,
        action: "view",
        query: DriverListQuery,
        invalid: ["a filter is malformed", "`projectId` is not a project this account works in (for a provider's account, one its provider holds a Service Area in)"],
        responses: {
          200: describeJson("One page of drivers.", DriverPage),
        },
      },
      async (c) => {
        const { limit, cursor, projectId, status, licenceClass, homeDepotId } = c.req.valid("query")
        const at = pageAt({ cursor, limit })
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) await requireReachedProject(tx, principal, projectId, now, "projectId", "query")
        const { items, nextCursor } = await listDrivers(tx, principal, at, projectId === undefined ? undefined : eq(driver.projectId, projectId), status === undefined ? undefined : eq(driver.status, status), licenceClass === undefined ? undefined : eq(driver.licenceClass, licenceClass), homeDepotId === undefined ? undefined : eq(driver.homeDepotId, homeDepotId))
        return c.json({ items: items.map(driverOf), nextCursor })
      },
    )
    .post(
      "/drivers",
      {
        operationId: "createDriver",
        summary: "Register a driver",
        description:
          "Registers a workforce profile in one project, which must be a project the caller works in. The workforce reference, where given, is unique across the company; the login (`userAccountId`), where given, is a user account of this company that is not deactivated, and one account is the login of at most one driver. The employing service provider is this company's and is named with `service-provider` employment and with nothing else; the home depot is the named project's. The licence is three attributes: the class held (`b`, `c` or `ce`; null is not on record, which is eligible for nothing), the number, and the expiry as the last day it holds — whether a driver may take a vehicle on a day is judged where a vehicle is named, never here. `status` defaults to `active`. A Service Provider's account registers its own drivers: in a project its provider holds a Service Area in today, with `service-provider` employment naming its own provider, and a login, where given, of its own team — anything else is refused at the field. The server mints the id.",
        module: MODULE,
        action: "create",
        body: DriverCreate,
        invalid: ["the body is missing a field, names a member the server owns, names a project this account does not work in, gives a class outside `b`, `c`, `ce` or an expiry that is not a calendar day, names the provider without service-provider employment or the employment without a provider, or names a service provider, depot or user account outside the scope its key allows — each at the field that is wrong"],
        responses: {
          201: describeCreated("The driver as it was written.", Driver),
          409: describeProblem("The company already has a driver with that workforce reference, or that login already has a driver profile."),
        },
      },
      async (c) => created(c, "/drivers", await createDriver(c.get("tx"), c.get("principal"), c.req.valid("json"), now)),
    )
    .get(
      "/drivers/:id",
      {
        operationId: "getDriver",
        summary: "One driver",
        description: "One driver of a project the caller works in. A driver of another company, or of a project this account does not work in, is a driver that does not exist here.",
        module: MODULE,
        action: "view",
        params: IdParam,
        responses: {
          200: describeJson("The driver.", Driver),
          404: describeProblem("No driver with that id in the projects this account works in, or, for a Service Provider's account, none its provider employs."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await getDriver(tx, principal, id)
        return c.json(driverOf(row))
      },
    )
    .patch(
      "/drivers/:id",
      {
        operationId: "patchDriver",
        summary: "Change a driver",
        description:
          "Changes one driver of a project the caller works in; every field is optional and at least one must be given. The project is not patchable, since a record does not move between projects. A null clears the workforce reference, the provider, the home depot, the licence class, number or expiry, the login or the notes. The provider rule is held against the row the patch leaves behind: a `service-provider` driver names the employing provider and no other does. A new provider is this company's, a new home depot this project's, a new login a user account of this company that is not deactivated and not already another driver's. A licence renewal is an edit here — the class and the expiry move — and the audit log is its history. A status change is a plain patch except taking the driver out of service: `inactive` or `suspended` under a live allocation — planned or confirmed and not yet over — or under a collection group of a route scheme in force today, whatever that scheme's status, is refused (409) counting them — release the allocations, reassign the groups, and set it then. Both counts run under the driver's row lock, and a driver already inactive or suspended is not asked again when moved to the other.",
        module: MODULE,
        action: "edit",
        params: IdParam,
        body: DriverPatch,
        invalid: ["the patch is empty, names a field the caller does not own (the project included), gives a class outside `b`, `c`, `ce` or an expiry that is not a calendar day, leaves the employment and the provider disagreeing, or names a service provider, depot or user account outside the scope its key allows"],
        responses: {
          200: describeJson("The driver as it now stands.", Driver),
          404: describeProblem("No driver with that id in the projects this account works in, or, for a Service Provider's account, none its provider employs."),
          409: describeProblem(
            "The company already has another driver with that workforce reference, that login already has a driver profile, or the driver is being set inactive or suspended under live allocations or under collection groups of schemes in force: the detail counts them.",
          ),
        },
      },
      async (c) => c.json(await patchDriver(c.get("tx"), c.get("principal"), c.req.valid("param").id, c.req.valid("json"), now)),
    )
}

// Execution, slice 4 (Issue #104): the driver door's `GET /driver/me` answers the caller's own profile in this same shape, so the columns and the mapper are read from here rather than spelled again.
export { columns as driverColumns, driverOf }
