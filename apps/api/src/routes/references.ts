// An id a body names, held to the scope its key allows (Issue #78).
//
// `requireRow` (routes/shared.ts) is the statement — a row of this company,
// under whatever else its key demands — and the sentence was left with the
// route, which knows what the thing is called. That held while one route
// named a thing. It stopped holding when the second did: a container type is
// named by a Product and by a Container, a waste fraction by a Product and
// by a Placement, a Property by a Group's members and by a Subscription, and
// "Not a container type of this company" was about to be typed twice. So
// every singular check is here, one function per family, each spelling its
// sentence once and defaulting `path` to the field a body usually carries it
// in.
//
// Two scopes and no others, because the keys allow no others: master data
// (a container type, a waste fraction) and a Customer are the company's, and
// everything a Project owns (a service frequency, a Product, a Property, a
// Shared Collection Point) is the project's as well — their keys carry
// `project_id`, so a row of another project is a row this one may not name.
//
// A null or an absent id points at nothing, which is nothing to check: every
// field that carries one of these is optional somewhere.
//
// The set-shaped checks stay in routes/members.ts, where the mechanics that
// need them are: a body may name two hundred properties and that is one
// statement, not two hundred of these. They read their sentences from here,
// so the singular and the plural refusal say the same thing.
//
// Four of the seven answer the row's status with the proof that it is there —
// a Customer, a Product, a Property, a Shared Collection Point — because a new
// reference is gated on it (routes/statuses.ts, Issue #79) and one statement
// that says both is better than two that say one each. The refusal for a row
// that is not there is unchanged, and comes first: the state of a row is only
// a question once the row is. The other three have no status to answer.
import type { ProductStatus } from "@waste/contracts/catalogue"
import type { CustomerStatus, PropertyStatus, SharedCollectionPointStatus } from "@waste/contracts/customers"
import type { Tx } from "@waste/db/client"
import { projectAccess, userAccount } from "@waste/db/schema/access"
import { agreement } from "@waste/db/schema/agreements"
import { containerType, product, serviceFrequency, wasteFraction } from "@waste/db/schema/catalogue"
import { container } from "@waste/db/schema/containers"
import { customer, property, sharedCollectionPoint } from "@waste/db/schema/customers"
import { pickup, route, session } from "@waste/db/schema/execution"
import { priceList, serviceAreaAssignment } from "@waste/db/schema/finance"
import { driver, vehicle } from "@waste/db/schema/fleet"
import { vehicleType } from "@waste/db/schema/fleet-types"
import { serviceProvider } from "@waste/db/schema/organisation"
import { depot, unloadingStation, warehouse } from "@waste/db/schema/places"
import { planningArea } from "@waste/db/schema/planning-areas"
import { ticket } from "@waste/db/schema/resolution"
import type { DriverStatus, VehicleKind, VehicleStatus, WarehouseStatus } from "@waste/domain/resources/vocabulary"
import { and, eq, exists, inArray, isNull, or, sql } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"

import { invalidRequest } from "../problem"
import { findAlert, NOT_AN_ALERT } from "./alert-links"
import type { AlertRow } from "./resolution-shapes"
import { requireRow, requireStatus, rowIssue, type NamedRow, type Refusal, type Target, type TenantTable } from "./shared"

/** What a body is told when it names a customer this company does not have; one sentence, wherever the id sat. */
export const NOT_A_CUSTOMER = "Not a customer of this company"

/** What a body is told when it reaches for a property of another project; the fence the composite key already holds it to. */
export const NOT_A_PROPERTY = "Not a property of this project"

/** A table whose rows belong to a Project as well as to the company. */
type ProjectTable = TenantTable & { projectId: PgColumn }

/** What a project-scoped lookup is bounded by: the caller's company, and the project the parent record is in. */
export type Scope = { companyId: string; projectId: string }

/** The scope a company-wide key allows: this company, whatever project the row is in. */
const inCompany = (companyId: string, id: string): NamedRow => ({ companyId, id })

/** The scope a key carrying `project_id` allows: this company and this project. */
const inProject = (table: ProjectTable, scope: Scope, id: string): NamedRow => ({
  companyId: scope.companyId,
  id,
  also: eq(table.projectId, scope.projectId),
})

/**
 * A Customer a body names: the party to an Agreement, the customer it is
 * billed to, the one a Property Group or a Shared Collection Point answers
 * to. A Customer is company-wide — the same housing administrator is a
 * customer of every project — so the project does not come into it, and
 * since the fence hides another company's row, "it is not yours" and "it
 * does not exist" are the same answer. Answers the status. A `query` target
 * is a list filter's (`GET /tickets?customerId=`, the portal's read, Issue
 * #109), refused on the query string.
 */
export async function requireCustomer(
  tx: Tx,
  companyId: string,
  id: string | null | undefined,
  path = "customerId",
  target: Target = "body",
): Promise<CustomerStatus | undefined> {
  if (id == null) return undefined
  return await requireStatus<CustomerStatus>(tx, customer, inCompany(companyId, id), { path, message: NOT_A_CUSTOMER }, target)
}

/** A container type a body names: the company's, since a label is read off a bin anywhere in the company. */
export async function requireContainerType(tx: Tx, companyId: string, id: string | null | undefined, path = "containerTypeId"): Promise<void> {
  if (id == null) return
  await requireRow(tx, containerType, inCompany(companyId, id), { path, message: "Not a container type of this company" })
}

/** A waste fraction a body or a query names: the company's, since a fraction is what the country sorts, not what a project does. A `query` target is a list filter's (`GET /unloading-stations?wasteFractionId=`, #101 round A), refused on the query string. */
export async function requireWasteFraction(tx: Tx, companyId: string, id: string | null | undefined, path = "wasteFractionId", target: Target = "body"): Promise<void> {
  if (id == null) return
  await requireRow(tx, wasteFraction, inCompany(companyId, id), { path, message: "Not a waste fraction of this company" }, target)
}

/** A service frequency a body names: the project's, since a cadence belongs to one project (`project_id` leads its key). */
export async function requireServiceFrequency(
  tx: Tx,
  scope: Scope,
  id: string | null | undefined,
  path = "serviceFrequencyId",
): Promise<void> {
  if (id == null) return
  await requireRow(tx, serviceFrequency, inProject(serviceFrequency, scope, id), { path, message: "Not a service frequency of this project" })
}

/** What a body or a query is told when it reaches for a product of another project. */
export const NOT_A_PRODUCT = "Not a product of this project"

/** A Product a body names: the project's, since a catalogue is a project's offer. Answers the status. */
export async function requireProduct(
  tx: Tx,
  scope: Scope,
  id: string | null | undefined,
  path = "productId",
): Promise<ProductStatus | undefined> {
  if (id == null) return undefined
  return await requireStatus<ProductStatus>(tx, product, inProject(product, scope, id), { path, message: NOT_A_PRODUCT })
}

/** A Property a body names: the project's, since a service address is served under one project. Answers the status. */
export async function requireProperty(
  tx: Tx,
  scope: Scope,
  id: string | null | undefined,
  path = "propertyId",
): Promise<PropertyStatus | undefined> {
  if (id == null) return undefined
  return await requireStatus<PropertyStatus>(tx, property, inProject(property, scope, id), { path, message: NOT_A_PROPERTY })
}

/** A Shared Collection Point a body names: the project's, like the properties it serves. Answers the status. */
export async function requireSharedCollectionPoint(
  tx: Tx,
  scope: Scope,
  id: string | null | undefined,
  path = "sharedCollectionPointId",
): Promise<SharedCollectionPointStatus | undefined> {
  if (id == null) return undefined
  return await requireStatus<SharedCollectionPointStatus>(tx, sharedCollectionPoint, inProject(sharedCollectionPoint, scope, id), {
    path,
    message: "Not a shared collection point of this project",
  })
}

// The Planning context (Issue #97) keys everything on a Project too, so its
// checks are all `inProject`. A collection calendar has no check here: no body
// names one (the path does, and a scheme reads its project's calendars and
// never picks one), and a check nothing calls is added the day something does.

/** What a body is told when it reaches for a planning area of another project; the fence the composite key already holds it to. */
export const NOT_A_PLANNING_AREA = "Not a planning area of this project"

/** A Planning Area a body names: the project's, since where work happens is planned inside one project. */
export async function requirePlanningArea(
  tx: Tx,
  scope: Scope,
  id: string | null | undefined,
  path = "planningAreaId",
): Promise<void> {
  if (id == null) return
  await requireRow(tx, planningArea, inProject(planningArea, scope, id), { path, message: NOT_A_PLANNING_AREA })
}

// What a Collection Group names (Issue #97, slice 4): a container is the
// project's, like the group that picks it, and the plural check over a picked
// list (routes/scheme-groups.ts) hands the one entry it found missing to the
// singular here, so both say the same thing; a Service Provider is the
// company's, since Organisation & Access has the table. A scheme and a group
// are named by no body yet — the path names them — so their checks arrive
// with part B, the day a body does.

/** A Container a body names: the project's, since a group cannot pick another project's bin. */
export async function requireContainer(tx: Tx, scope: Scope, id: string | null | undefined, path = "containerId"): Promise<void> {
  if (id == null) return
  await requireRow(tx, container, inProject(container, scope, id), { path, message: "Not a container of this project" })
}

/** What a body is told when it names a service provider this company does not have. */
export const NOT_A_SERVICE_PROVIDER = "Not a service provider of this company"

/** A Service Provider a body names: the company's, since the provider is the company's counterparty and no project's. */
export async function requireServiceProvider(tx: Tx, companyId: string, id: string | null | undefined, path = "serviceProviderId"): Promise<void> {
  if (id == null) return
  await requireRow(tx, serviceProvider, inCompany(companyId, id), { path, message: NOT_A_SERVICE_PROVIDER })
}

/** The same check as the field error or nothing (`rowIssue`, routes/shared.ts), for a route listing it beside other refusals in one 400 (a place patch, routes/place-rules.ts); an id that is null or absent names nothing and is no issue. */
export async function serviceProviderIssue(tx: Tx, companyId: string, id: string | null | undefined, path = "serviceProviderId"): Promise<Refusal | undefined> {
  if (id == null) return undefined
  return await rowIssue(tx, serviceProvider, inCompany(companyId, id), { path, message: NOT_A_SERVICE_PROVIDER })
}

// Resources (Issue #101): a vehicle type is the company's vocabulary, a row
// and not a token, so a Stop Matching Rule that asks for one names one of the
// company's. The place and fleet checks of the other families arrive with
// their routes, slices 3 and 4, the day a body names them.

/** A vehicle type a body names: the company's, since one company's "Rear loader" is another's "Baglæsser". */
export async function requireVehicleType(tx: Tx, companyId: string, id: string | null | undefined, path = "vehicleTypeId"): Promise<void> {
  if (id == null) return
  await requireRow(tx, vehicleType, inCompany(companyId, id), { path, message: "Not a vehicle type of this company" })
}

// Resources, slice 2 round: the one check the container list makes of its
// `warehouseId` filter, spelled here since slices 3 and 5 name a warehouse
// from a body too (a depot's colocated warehouse, a movement's place).

/** What a body or a query is told when it reaches for a warehouse outside the project, or the projects, it may see. */
export const NOT_A_WAREHOUSE = "Not a warehouse of this project"

/** The warehouse a check found, as the ledger's status gate reads it (routes/statuses.ts, #101 round A): the name a sentence says and the status it judges. */
export type WarehouseRef = { id: string; name: string; status: WarehouseStatus }

/**
 * A warehouse a body or a query names: the project's — or, for a list that
 * names no project, one of the caller's projects, handed in as their ids. A
 * `query` target is refused on the query string; a body on the body. Answers
 * the row it found, so the ledger can hold its status without a second
 * statement (#79: a status gates a new reference and never an existing one);
 * undefined for an id that is null or absent, which points at nothing.
 */
export async function requireWarehouse(
  tx: Tx,
  scope: { companyId: string; projectId: string | readonly string[] },
  id: string | null | undefined,
  path = "warehouseId",
  target: Target = "body",
): Promise<WarehouseRef | undefined> {
  if (id == null) return undefined
  const refusal = () => invalidRequest(target, [{ path, message: NOT_A_WAREHOUSE }])
  const projects = typeof scope.projectId === "string" ? [scope.projectId] : [...scope.projectId]
  // An account that works in no project sees no warehouse; `in ()` is not SQL.
  if (projects.length === 0) throw refusal()
  const [found] = await tx
    .select({ id: warehouse.id, name: warehouse.name, status: warehouse.status })
    .from(warehouse)
    .where(and(eq(warehouse.companyId, scope.companyId), inArray(warehouse.projectId, projects), eq(warehouse.id, id)))
    .limit(1)
  if (found === undefined) throw refusal()
  // `status` is text with a CHECK in the database and the vocabulary's tuple here.
  return { id: found.id, name: found.name, status: found.status as WarehouseStatus }
}

// Resources, slice 3 (Issue #101): the other two places. A depot is a
// project's — a warehouse names the depot it shares a yard with, a vehicle and
// a driver their home depot, a scheme the one its routes leave from — so its
// check is `inProject`; an unloading station is the company's, since ARC
// Amager is where every Copenhagen project unloads, so a scheme that names one
// names one of the company's. A warehouse's check is the slice 2 round's above.

/** What a body is told when it reaches for a depot of another project; the fence the composite key already holds it to. */
export const NOT_A_DEPOT = "Not a depot of this project"

/** What a body is told when it names an unloading station this company does not have. */
export const NOT_AN_UNLOADING_STATION = "Not an unloading station of this company"

/** A Depot a body names: the project's, since a route leaves from its project's yard. */
export async function requireDepot(tx: Tx, scope: Scope, id: string | null | undefined, path = "depotId"): Promise<void> {
  if (id == null) return
  await requireRow(tx, depot, inProject(depot, scope, id), { path, message: NOT_A_DEPOT })
}

/** An Unloading Station a body names: the company's, since every project of the company unloads at the same plants. */
export async function requireUnloadingStation(tx: Tx, companyId: string, id: string | null | undefined, path = "unloadingStationId"): Promise<void> {
  if (id == null) return
  await requireRow(tx, unloadingStation, inCompany(companyId, id), { path, message: NOT_AN_UNLOADING_STATION })
}

// Resources, slice 4 (Issue #101): the fleet. A vehicle and a driver are the
// project's, like the depot they are based at, so both checks are `inProject`.
// A vehicle is asked for with the kind the caller demands — an allocation's
// `vehicleId` is a powered vehicle and its `trailerId` a trailer, a collection
// group's vehicle a powered one — and the kind goes into the one statement
// beside the project: a trailer offered where a powered vehicle is required
// is "not a powered vehicle of this project" the way another project's is,
// since the sentence names what was asked for and the caller can pick
// another. A driver's login is a user account of this company that is not
// deactivated; whether it has signed in yet is the account's business, not
// the driver profile's. Where a caller needs the row and not only its
// existence — the class a vehicle requires, the licence a driver holds —
// routes/fleet-lookups.ts reads it, refusing in the sentences spelled here.
// Both checks answer the row's status (round B of the #101 review, #79's
// rule: a status gates a new reference and never an existing one) through
// `requireStatus` in routes/shared.ts — `requireRow`'s statement with one
// column more, the same 400 at the field when there is no such row — so a
// route naming a vehicle or a driver afresh can refuse a retired or an
// unavailable one through routes/statuses.ts without a second statement, and
// a route that only touches a row already naming them asks nothing.

/** What a body is told when the vehicle it names is not one of the project's, or not of the kind asked for. */
export const NOT_A_VEHICLE = "Not a vehicle of this project"
export const NOT_A_POWERED_VEHICLE = "Not a powered vehicle of this project"
export const NOT_A_TRAILER = "Not a trailer of this project"

/** The sentence for a vehicle held to a kind, or to none; routes/fleet-lookups.ts's `findVehicle` refuses with it too. */
export const notAVehicleOf = (kind: VehicleKind | undefined): string => (kind === "powered-vehicle" ? NOT_A_POWERED_VEHICLE : kind === "trailer" ? NOT_A_TRAILER : NOT_A_VEHICLE)

/**
 * A Vehicle a body names: the project's, and of the kind demanded when one
 * is. One statement and one sentence, the kind in the `where` beside the
 * project, so a row of the wrong kind and a row that is not there are told
 * the same thing — which names what the field wanted. The kind and the path
 * travel in one options object, since a caller that names the one usually
 * names the other (`trailerId` is a trailer). Answers the row's status, or
 * undefined for an id that named nothing, so the caller can hold a new
 * reference to it (routes/statuses.ts) with no second read.
 */
export async function requireVehicle(
  tx: Tx,
  scope: Scope,
  id: string | null | undefined,
  { kind, path = "vehicleId" }: { kind?: VehicleKind; path?: string } = {},
): Promise<VehicleStatus | undefined> {
  if (id == null) return undefined
  return await requireStatus<VehicleStatus>(
    tx,
    vehicle,
    { companyId: scope.companyId, id, also: and(eq(vehicle.projectId, scope.projectId), kind === undefined ? undefined : eq(vehicle.kind, kind)) },
    { path, message: notAVehicleOf(kind) },
  )
}

/** What a body is told when it names a driver of another project. */
export const NOT_A_DRIVER = "Not a driver of this project"

/** A Driver a body names: the project's, since a workforce profile is based in one project like the vehicle it takes out; answers the status like `requireVehicle`. */
export async function requireDriver(tx: Tx, scope: Scope, id: string | null | undefined, path = "driverId"): Promise<DriverStatus | undefined> {
  if (id == null) return undefined
  return await requireStatus<DriverStatus>(tx, driver, inProject(driver, scope, id), { path, message: NOT_A_DRIVER })
}

/** What a driver body is told when the login it names is not an account here, or is a deactivated one. */
export const NOT_A_USER_ACCOUNT = "Not a user account of this company"

/** A user account a body names as a driver's login: this company's, active or invited — a deactivated account is no login to drive under. */
export async function requireUserAccount(tx: Tx, companyId: string, id: string | null | undefined, path = "userAccountId"): Promise<void> {
  if (id == null) return
  await requireRow(tx, userAccount, { companyId, id, also: isNull(userAccount.deactivatedAt) }, { path, message: NOT_A_USER_ACCOUNT })
}

// Execution (Issue #104): a route, a pickup and a session are named
// by the office's list filters (`?routeId=` on the pickups, sessions and
// unloads lists) and by the driver door's commands, so their checks are here
// like every other family's. A route is the project's — or, for a list that
// names no project, one of the caller's projects, handed in as their ids, the
// way `requireWarehouse` takes them — and a pickup and a session are a
// route's: their keys carry the route (`pickup_route_id_project_key`,
// `session_route_id_project_key`), so a pickup of another route is a pickup
// this one may not name, whatever project it is in.

/** What a body or a query is told when it names a route outside the project, or the projects, it may see. */
export const NOT_A_ROUTE = "Not a route of this project"

/** What a body is told when it names a pickup that is not the route's. */
export const NOT_A_PICKUP = "Not a pickup of this route"

/** What a body is told when it names a session that is not the route's. */
export const NOT_A_SESSION = "Not a session of this route"

/** What a route's children are bounded by: the caller's company and the route they hang off. */
export type RouteScope = { companyId: string; routeId: string }

/**
 * A Route a body or a query names: the project's — or, for a list that names
 * no project, one of the caller's projects, handed in as their ids. A `query`
 * target is refused on the query string; a body on the body. An id that is
 * null or absent names nothing and is no issue.
 */
export async function requireRoute(
  tx: Tx,
  scope: { companyId: string; projectId: string | readonly string[] },
  id: string | null | undefined,
  path = "routeId",
  target: Target = "body",
): Promise<void> {
  if (id == null) return
  const projects = typeof scope.projectId === "string" ? [scope.projectId] : [...scope.projectId]
  // An account that works in no project reaches no route; `in ()` is not SQL.
  if (projects.length === 0) throw invalidRequest(target, [{ path, message: NOT_A_ROUTE }])
  await requireRow(tx, route, { companyId: scope.companyId, id, also: inArray(route.projectId, projects) }, { path, message: NOT_A_ROUTE }, target)
}

/** A Pickup a body names: the route's, since a proof or a receipt names a stop of the route it names and no other. */
export async function requirePickup(tx: Tx, scope: RouteScope, id: string | null | undefined, path = "pickupId", target: Target = "body"): Promise<void> {
  if (id == null) return
  await requireRow(tx, pickup, { companyId: scope.companyId, id, also: eq(pickup.routeId, scope.routeId) }, { path, message: NOT_A_PICKUP }, target)
}

/** A Session a body names: the route's, for the same reason. */
export async function requireSession(tx: Tx, scope: RouteScope, id: string | null | undefined, path = "sessionId", target: Target = "body"): Promise<void> {
  if (id == null) return
  await requireRow(tx, session, { companyId: scope.companyId, id, also: eq(session.routeId, scope.routeId) }, { path, message: NOT_A_SESSION }, target)
}

// Resolution (Issue #109): what a ticket names, and what names a ticket. A
// ticket's nine links are the Registry's, Resources' and Execution's rows and
// read the checks above; three are new here — a parent ticket, an alert and
// an agreement, each the project's, since every ticket, alert and agreement
// is a Project's, so all three are `inProject` — and one is a rule on an
// account rather than a row: the assignee works in the ticket's project,
// `all_projects` or a Project Access row, since a ticket assigned to someone
// who cannot see it is a bug and not a choice (#109 §3). No status is
// answered for a link: a ticket is about whatever it is about — a complaint
// about an inactive customer's last collection, a defect on a retired
// container — and #79's gate does not apply to it (§7.13); the one gate, the
// re-collection route's, is the route's own, and an alert about a ticket
// names it whatever state either is in. The alert's check answers the row and
// not only its existence, since what names an alert judges it next: the one
// function `POST /tickets` and `POST /alerts/:id/link-ticket` share
// (routes/alert-links.ts) reads its status and the ticket it already names
// under the alert's lock, and one statement that says all three is better
// than three. An id that is null or absent names nothing and is no issue, as
// everywhere here; the overloads say so to the type checker, so a caller with
// an id in hand reads the row without a guard.

/** What a body is told when it names a ticket of another project, or none. */
export const NOT_A_TICKET = "Not a ticket of this project"

/** What a body is told when it names an alert of another project, or none: the shared statement's sentence (`@waste/db/commands/alert-links`), since `openTicket` answers it too. */
export { NOT_AN_ALERT }

/** What a body is told when it names an agreement of another project, or none. */
export const NOT_AN_AGREEMENT = "Not an agreement of this project"

/** What a body is told when the account it names is this company's but works in another project. */
export const NOT_WORKING_IN_PROJECT = "Not a user account working in this project"

/** A Ticket a body names — as a parent case, or as the ticket an alert answers or is linked to: the project's, through the table's own project key. */
export async function requireTicket(tx: Tx, scope: Scope, id: string | null | undefined, path = "ticketId"): Promise<void> {
  if (id == null) return
  await requireRow(tx, ticket, inProject(ticket, scope, id), { path, message: NOT_A_TICKET })
}

/**
 * An Alert a body names: the project's. Answers the row whole, as the link
 * rule reads it (routes/alert-links.ts: its status, and the one ticket it is
 * linked to or null) and as the link command answers it once linked, so the
 * proof it is there is the one read; undefined for an id that named nothing.
 */
export async function requireAlert(tx: Tx, scope: Scope, id: string, options?: { path?: string }): Promise<AlertRow>
export async function requireAlert(tx: Tx, scope: Scope, id: string | null | undefined, options?: { path?: string }): Promise<AlertRow | undefined>
export async function requireAlert(tx: Tx, scope: Scope, id: string | null | undefined, { path = "alertId" }: { path?: string } = {}): Promise<AlertRow | undefined> {
  if (id == null) return undefined
  const found = await findAlert(tx, scope, id)
  if (found === undefined) throw invalidRequest("body", [{ path, message: NOT_AN_ALERT }])
  return found
}

/** An Agreement a body names: the project's, since an agreement is made under one project's catalogue. */
export async function requireAgreement(tx: Tx, scope: Scope, id: string | null | undefined, path = "agreementId"): Promise<void> {
  if (id == null) return
  await requireRow(tx, agreement, inProject(agreement, scope, id), { path, message: NOT_AN_AGREEMENT })
}

/**
 * A user account a body names as a ticket's assignee: this company's and not
 * deactivated (`requireUserAccount`, the company half and its sentence), and
 * working in the ticket's project — `all_projects`, or a Project Access row
 * naming it. Two statements, the company's first, so an account that is not
 * here at all is told that and not that it works elsewhere.
 */
export async function requireAccountInProject(tx: Tx, scope: Scope, id: string | null | undefined, path = "assigneeUserAccountId"): Promise<void> {
  if (id == null) return
  await requireUserAccount(tx, scope.companyId, id, path)
  const [found] = await tx
    .select({ id: userAccount.id })
    .from(userAccount)
    .where(
      and(
        eq(userAccount.companyId, scope.companyId),
        eq(userAccount.id, id),
        or(
          eq(userAccount.allProjects, true),
          exists(
            tx
              .select({ one: sql`1` })
              .from(projectAccess)
              .where(and(eq(projectAccess.companyId, scope.companyId), eq(projectAccess.userAccountId, id), eq(projectAccess.projectId, scope.projectId))),
          ),
        ),
      ),
    )
    .limit(1)
  if (found === undefined) throw invalidRequest("body", [{ path, message: NOT_WORKING_IN_PROJECT }])
}

// Finance & Contracting (Issue #112): what a money row names. Every Finance
// table is a Project's, and two of its rows are named by other bodies — a
// Price List by an Agreement (the list it is priced under, held to the
// agreement's project and, by the route, to its currency), and a Service
// Area Assignment by a provider price and a settlement (the award they are
// made under). Both answer the row and not only its existence, since what
// names them judges them next: the list's currency (the agreement's rule),
// and the assignment's project and period (containment, routes/periods.ts) —
// a provider price and a settlement name an assignment and no project, so
// the assignment's project is where theirs comes from, and the check takes
// the caller's projects the way `requireRoute` does. Finance's other rows —
// a price row, an area, a provider price, a billable event, an invoice and
// its lines, a settlement, an unload — are named by their own routes' paths
// and by nothing a body carries, so no check is spelled for them; one is
// added when a body names the row, and never before (the review of #112
// removed eight that nothing called). No status is answered: a Finance row
// carries none, its Draft, Upcoming, Active and Expired being readings of its
// period.

/** What a body is told when it names a price list of another project, or none. */
export const NOT_A_PRICE_LIST = "Not a price list of this project"

/** What a body is told when it names an assignment outside the projects it may see, or none. */
export const NOT_AN_ASSIGNMENT = "Not an assignment of this project"

/** The price list a check found, as the agreement's rule reads it: the currency every row of it is quoted in. */
export type PriceListRef = { id: string; currency: string }

/**
 * A Price List a body names — the list an Agreement is priced under: the
 * project's. Answers the row's currency, since the route holds the agreement's
 * to it next ("The price list is in EUR; the agreement is billed in DKK"), and
 * one statement that says both is better than two; undefined for an id that
 * is null or absent, which is the project's default list and names nothing.
 */
export async function requirePriceList(tx: Tx, scope: Scope, id: string | null | undefined, path = "priceListId"): Promise<PriceListRef | undefined> {
  if (id == null) return undefined
  const [found] = await tx
    .select({ id: priceList.id, currency: priceList.currency })
    .from(priceList)
    .where(and(eq(priceList.companyId, scope.companyId), eq(priceList.projectId, scope.projectId), eq(priceList.id, id)))
    .limit(1)
  if (found === undefined) throw invalidRequest("body", [{ path, message: NOT_A_PRICE_LIST }])
  return found
}

/** The assignment a check found, as containment and the provider's own reads use it: its project, its area, its provider and its period. */
export type AssignmentRef = { id: string; projectId: string; serviceAreaId: string; serviceProviderId: string; validFrom: string; validTo: string | null }

/**
 * A Service Area Assignment a body names — the award a provider price or a
 * settlement is made under: one of the caller's projects, handed in as their
 * ids the way `requireRoute` takes them, since neither body names a project
 * and the assignment's is where theirs comes from. An account that works in
 * no project reaches none, whatever its role grants, so a provider's account
 * cannot price or settle its own award. Answers the row, so the route holds
 * the child's period inside it (routes/periods.ts) and reads the project's
 * currency, without a second statement; undefined for an id that is null or
 * absent, which the overload on a required id rules out for the two creates
 * that always name one.
 */
export async function requireServiceAreaAssignment(tx: Tx, scope: { companyId: string; projectId: string | readonly string[] }, id: string, path?: string): Promise<AssignmentRef>
export async function requireServiceAreaAssignment(
  tx: Tx,
  scope: { companyId: string; projectId: string | readonly string[] },
  id: string | null | undefined,
  path?: string,
): Promise<AssignmentRef | undefined>
export async function requireServiceAreaAssignment(
  tx: Tx,
  scope: { companyId: string; projectId: string | readonly string[] },
  id: string | null | undefined,
  path = "serviceAreaAssignmentId",
): Promise<AssignmentRef | undefined> {
  if (id == null) return undefined
  const refusal = () => invalidRequest("body", [{ path, message: NOT_AN_ASSIGNMENT }])
  const projects = typeof scope.projectId === "string" ? [scope.projectId] : [...scope.projectId]
  // An account that works in no project names no assignment; `in ()` is not SQL.
  if (projects.length === 0) throw refusal()
  const [found] = await tx
    .select({
      id: serviceAreaAssignment.id,
      projectId: serviceAreaAssignment.projectId,
      serviceAreaId: serviceAreaAssignment.serviceAreaId,
      serviceProviderId: serviceAreaAssignment.serviceProviderId,
      validFrom: serviceAreaAssignment.validFrom,
      validTo: serviceAreaAssignment.validTo,
    })
    .from(serviceAreaAssignment)
    .where(and(eq(serviceAreaAssignment.companyId, scope.companyId), inArray(serviceAreaAssignment.projectId, projects), eq(serviceAreaAssignment.id, id)))
    .limit(1)
  if (found === undefined) throw refusal()
  return found
}
