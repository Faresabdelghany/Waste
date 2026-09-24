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
import { customer, property, sharedCollectionPoint } from "@waste/db/schema/customers"
import { eq } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"

import { requireRow, requireStatus, type StatusTable, type TenantTable } from "./shared"

/** What a body is told when it names a customer this company does not have; one sentence, wherever the id sat. */
export const NOT_A_CUSTOMER = "Not a customer of this company"

/** What a body is told when it reaches for a property of another project; the fence the composite key already holds it to. */
export const NOT_A_PROPERTY = "Not a property of this project"

/** A table whose rows belong to a Project as well as to the company. */
type ProjectTable = TenantTable & { projectId: PgColumn }

/** What a project-scoped lookup is bounded by: the caller's company, and the project the parent record is in. */
type Scope = { companyId: string; projectId: string }

/** A row of this company, whatever project it is in: the scope a company-wide key allows. */
async function ofCompany(tx: Tx, table: TenantTable, companyId: string, id: string | null | undefined, path: string, message: string): Promise<void> {
  if (id == null) return
  await requireRow(tx, table, { companyId, id }, { path, message })
}

/** A row of this company and this project: the scope a key carrying `project_id` allows. */
async function ofProject(
  tx: Tx,
  table: ProjectTable,
  scope: Scope,
  id: string | null | undefined,
  path: string,
  message: string,
): Promise<void> {
  if (id == null) return
  await requireRow(tx, table, { companyId: scope.companyId, id, also: eq(table.projectId, scope.projectId) }, { path, message })
}

/** The same two for a table whose rows carry a status, answering it; nothing named is nothing to answer. */
async function stateOfCompany(
  tx: Tx,
  table: StatusTable,
  companyId: string,
  id: string | null | undefined,
  path: string,
  message: string,
): Promise<string | undefined> {
  if (id == null) return undefined
  return await requireStatus(tx, table, { companyId, id }, { path, message })
}

async function stateOfProject(
  tx: Tx,
  table: StatusTable & ProjectTable,
  scope: Scope,
  id: string | null | undefined,
  path: string,
  message: string,
): Promise<string | undefined> {
  if (id == null) return undefined
  return await requireStatus(tx, table, { companyId: scope.companyId, id, also: eq(table.projectId, scope.projectId) }, { path, message })
}

/**
 * A Customer a body names: the party to an Agreement, the customer it is
 * billed to, the one a Property Group or a Shared Collection Point answers
 * to. A Customer is company-wide — the same housing administrator is a
 * customer of every project — so the project does not come into it, and
 * since the fence hides another company's row, "it is not yours" and "it
 * does not exist" are the same answer. Answers the status, which the column's
 * check holds to the vocabulary.
 */
export async function requireCustomer(
  tx: Tx,
  companyId: string,
  id: string | null | undefined,
  path = "customerId",
): Promise<CustomerStatus | undefined> {
  return (await stateOfCompany(tx, customer, companyId, id, path, NOT_A_CUSTOMER)) as CustomerStatus | undefined
}

/** A container type a body names: the company's, since a label is read off a bin anywhere in the company. */
export async function requireContainerType(tx: Tx, companyId: string, id: string | null | undefined, path = "containerTypeId"): Promise<void> {
  await ofCompany(tx, containerType, companyId, id, path, "Not a container type of this company")
}

/** A waste fraction a body names: the company's, since a fraction is what the country sorts, not what a project does. */
export async function requireWasteFraction(tx: Tx, companyId: string, id: string | null | undefined, path = "wasteFractionId"): Promise<void> {
  await ofCompany(tx, wasteFraction, companyId, id, path, "Not a waste fraction of this company")
}

/** A service frequency a body names: the project's, since a cadence belongs to one project (`project_id` leads its key). */
export async function requireServiceFrequency(
  tx: Tx,
  scope: Scope,
  id: string | null | undefined,
  path = "serviceFrequencyId",
): Promise<void> {
  await ofProject(tx, serviceFrequency, scope, id, path, "Not a service frequency of this project")
}

/** A Product a body names: the project's, since a catalogue is a project's offer. Answers the status. */
export async function requireProduct(
  tx: Tx,
  scope: Scope,
  id: string | null | undefined,
  path = "productId",
): Promise<ProductStatus | undefined> {
  return (await stateOfProject(tx, product, scope, id, path, "Not a product of this project")) as ProductStatus | undefined
}

/** A Property a body names: the project's, since a service address is served under one project. Answers the status. */
export async function requireProperty(
  tx: Tx,
  scope: Scope,
  id: string | null | undefined,
  path = "propertyId",
): Promise<PropertyStatus | undefined> {
  return (await stateOfProject(tx, property, scope, id, path, NOT_A_PROPERTY)) as PropertyStatus | undefined
}

/** A Shared Collection Point a body names: the project's, like the properties it serves. Answers the status. */
export async function requireSharedCollectionPoint(
  tx: Tx,
  scope: Scope,
  id: string | null | undefined,
  path = "sharedCollectionPointId",
): Promise<SharedCollectionPointStatus | undefined> {
  return (await stateOfProject(tx, sharedCollectionPoint, scope, id, path, "Not a shared collection point of this project")) as
    | SharedCollectionPointStatus
    | undefined
}
