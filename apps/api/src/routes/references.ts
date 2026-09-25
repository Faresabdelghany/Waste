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
import { containerType, product, serviceFrequency, wasteFraction } from "@waste/db/schema/catalogue"
import { container } from "@waste/db/schema/containers"
import { customer, property, sharedCollectionPoint } from "@waste/db/schema/customers"
import { vehicleType } from "@waste/db/schema/fleet-types"
import { serviceProvider } from "@waste/db/schema/organisation"
import { depot, unloadingStation, warehouse } from "@waste/db/schema/places"
import { planningArea } from "@waste/db/schema/planning-areas"
import { and, eq, inArray } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"

import { invalidRequest } from "../problem"
import { requireRow, requireStatus, type NamedRow, type TenantTable } from "./shared"

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
 * does not exist" are the same answer. Answers the status.
 */
export async function requireCustomer(
  tx: Tx,
  companyId: string,
  id: string | null | undefined,
  path = "customerId",
): Promise<CustomerStatus | undefined> {
  if (id == null) return undefined
  return await requireStatus<CustomerStatus>(tx, customer, inCompany(companyId, id), { path, message: NOT_A_CUSTOMER })
}

/** A container type a body names: the company's, since a label is read off a bin anywhere in the company. */
export async function requireContainerType(tx: Tx, companyId: string, id: string | null | undefined, path = "containerTypeId"): Promise<void> {
  if (id == null) return
  await requireRow(tx, containerType, inCompany(companyId, id), { path, message: "Not a container type of this company" })
}

/** A waste fraction a body names: the company's, since a fraction is what the country sorts, not what a project does. */
export async function requireWasteFraction(tx: Tx, companyId: string, id: string | null | undefined, path = "wasteFractionId"): Promise<void> {
  if (id == null) return
  await requireRow(tx, wasteFraction, inCompany(companyId, id), { path, message: "Not a waste fraction of this company" })
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

/** A Product a body names: the project's, since a catalogue is a project's offer. Answers the status. */
export async function requireProduct(
  tx: Tx,
  scope: Scope,
  id: string | null | undefined,
  path = "productId",
): Promise<ProductStatus | undefined> {
  if (id == null) return undefined
  return await requireStatus<ProductStatus>(tx, product, inProject(product, scope, id), { path, message: "Not a product of this project" })
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

/** A Service Provider a body names: the company's, since the provider is the company's counterparty and no project's. */
export async function requireServiceProvider(tx: Tx, companyId: string, id: string | null | undefined, path = "serviceProviderId"): Promise<void> {
  if (id == null) return
  await requireRow(tx, serviceProvider, inCompany(companyId, id), { path, message: "Not a service provider of this company" })
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

/**
 * A warehouse a body or a query names: the project's — or, for a list that
 * names no project, one of the caller's projects, handed in as their ids. A
 * `query` target is refused on the query string; a body on the body.
 */
export async function requireWarehouse(
  tx: Tx,
  scope: { companyId: string; projectId: string | readonly string[] },
  id: string | null | undefined,
  path = "warehouseId",
  target: "body" | "query" = "body",
): Promise<void> {
  if (id == null) return
  const refusal = () => invalidRequest(target, [{ path, message: NOT_A_WAREHOUSE }])
  const projects = typeof scope.projectId === "string" ? [scope.projectId] : [...scope.projectId]
  // An account that works in no project sees no warehouse; `in ()` is not SQL.
  if (projects.length === 0) throw refusal()
  const [found] = await tx
    .select({ id: warehouse.id })
    .from(warehouse)
    .where(and(eq(warehouse.companyId, scope.companyId), inArray(warehouse.projectId, projects), eq(warehouse.id, id)))
    .limit(1)
  if (found === undefined) throw refusal()
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
