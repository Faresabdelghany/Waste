// What one row of a CSV import becomes (#291 slice 12, row 20.1): the row's
// cells read into the family's own create body and checked by the family's
// own schema, the record it names found by the key a person knows it by,
// and the write made through the family's own create or patch
// (customer-writes.ts, property-writes.ts, container-writes.ts,
// agreements.ts, and for the catalogue catalogue.ts and vehicle-types.ts) —
// never a second writer, so an imported record is held to
// every rule a form's is and a refusal says what a form's would.
//
// A row is written inside its own savepoint, so a refused row leaves nothing
// behind and the rows around it stand. Its outcome is `created` when it made
// a record, `updated` when it changed the one it matched, `unchanged` when
// the matched record already says what the row says, and `refused` with the
// sentence why: the column it names first, then the API's own words. An
// agreements row that names a product is the agreement and one subscription
// under it, both in the one savepoint; it is `created` when it made either,
// `updated` when it changed either, and it names the agreement.
//
// The keys: a customer by its registration number (unique in the company)
// and, without one, its e-mail, which several customers may share, and then
// the row is refused rather than guessed; a property by its address in the
// import's project, case and spacing aside; a container by its label,
// which is the company's, so a label in another project is refused; an
// agreement by its number and its first day in the project; a subscription
// by its product, its place and its first day under the agreement; a waste
// fraction and a vehicle type by their key, and a container type by its name
// (O30 of #290). Other
// records are named by the keys the template's column guide gives
// (@waste/domain/imports/columns): a container type, a product and a shared
// collection point by name, a price list by its code in force on the
// agreement's first day, a customer by registration number or, with an @ in
// it, by e-mail.
//
// An empty cell is no value: a create takes the field's default, and an
// update leaves the field as it stands — so a file cannot clear a field, and
// the key's own cells are never patched. The grant is the target module's:
// `create` for a row that makes a record, `edit` for one that changes it,
// asked per row, so a role that may edit but not create has its new rows
// refused and its matches written.
import {
  AgreementCreate,
  AgreementPatch,
  SubscriptionCreate,
  SubscriptionPatch,
} from "@waste/contracts/agreements"
import { ContainerTypeCreate, ContainerTypePatch, WasteFractionCreate, WasteFractionPatch } from "@waste/contracts/catalogue"
import { ContainerCreate, ContainerPatch } from "@waste/contracts/containers"
import { CustomerCreate, CustomerPatch, PropertyCreate, PropertyPartyRole, PropertyPatch, type PropertyParty } from "@waste/contracts/customers"
import { IsoDate } from "@waste/contracts/dates"
import { VehicleTypeCreate, VehicleTypePatch } from "@waste/contracts/vehicle-types"
import type { ImportKind, ImportRowResult, ImportRowValues } from "@waste/contracts/imports"
import type { Tx } from "@waste/db/client"
import { Refused } from "@waste/db/commands/shared"
import { validOn } from "@waste/db/query/valid-on"
import { containerType, product } from "@waste/db/schema/catalogue"
import { sharedCollectionPoint } from "@waste/db/schema/customers"
import { priceList } from "@waste/db/schema/finance"
import { project } from "@waste/db/schema/organisation"
import type { ModuleKey } from "@waste/domain/access/modules"
import { and, eq, sql } from "drizzle-orm"
import type * as z from "zod"

import type { Principal } from "../auth/principal"
import { requireAllowed } from "../auth/require"
import { ProblemError, refusedProblem } from "../problem"
import { agreementStarting, createAgreement, createSubscription, patchAgreement, patchSubscription, subscriptionStarting } from "./agreements"
import { containerTypeByName, createContainerType, createWasteFraction, patchContainerType, patchWasteFraction, wasteFractionByKey } from "./catalogue"
import { containerByLabel, containerOf, createContainer, findContainer, patchContainer } from "./container-writes"
import { createCustomer, customersByKey, patchCustomer } from "./customer-writes"
import { createProperty, patchProperty, propertiesAt, propertyWithParties, setPropertyParties } from "./property-writes"
import { createVehicleType, patchVehicleType, replaceVehicleTypeContainerTypes, vehicleTypeByKey } from "./vehicle-types"

/** The module each kind writes, whose grants a row is asked for. */
export const IMPORT_MODULES: Readonly<Record<ImportKind, ModuleKey>> = {
  customers: "customers.contacts",
  properties: "customers.properties",
  containers: "resources.containers",
  agreements: "customers.agreements",
  "waste-fractions": "configure.master",
  "container-types": "configure.master",
  "vehicle-types": "configure.master",
}

/** What a row is written in: the request's transaction, the caller, and the project the file is imported into (none for Customers). */
export type ImportContext = {
  tx: Tx
  principal: Principal
  projectId: string | null
  /** Read once per request and kept: the project's currency, an agreement's when its cell is empty. */
  memo: { currency?: string }
}

type Cells = Readonly<Record<string, string>>
type Written = { outcome: "created" | "updated" | "unchanged"; resourceId: string }

/** A row the import will not write, in the sentence it is refused with. */
class RowRefused extends Error {}

const refuse = (header: string, message: string): RowRefused => new RowRefused(`${header}: ${message}`)

/** Each body field by the column a file names it in, so a refusal names the column a person can fix. */
type Columns = Readonly<Record<string, string>>

const CUSTOMER_COLUMNS: Columns = {
  kind: "kind",
  name: "name",
  registrationNumber: "registration number",
  email: "email",
  phone: "phone",
  billingAddress: "billing address",
  serviceMessagesAllowed: "service messages",
  status: "status",
}
const PROPERTY_COLUMNS: Columns = { address: "address", name: "name", kind: "kind", registryId: "registry id", notes: "notes", status: "status", parties: "parties" }
const CONTAINER_COLUMNS: Columns = {
  label: "label",
  containerTypeId: "container type",
  barcode: "barcode",
  rfid: "rfid",
  serialNumber: "serial number",
  ownership: "ownership",
  notes: "notes",
}
const AGREEMENT_COLUMNS: Columns = {
  number: "number",
  customerId: "customer",
  payerCustomerId: "payer",
  billingCadence: "billing cadence",
  validFrom: "valid from",
  validTo: "valid to",
  status: "status",
  currency: "currency",
  priceListId: "price list",
  notes: "notes",
}
const FRACTION_COLUMNS: Columns = { key: "key", name: "name", wasteCode: "waste code", treatment: "treatment", densityKgPerCubicMetre: "density" }
const CONTAINER_TYPE_COLUMNS: Columns = { name: "name", volumeLitres: "volume", serviceSeconds: "service seconds" }
const VEHICLE_TYPE_COLUMNS: Columns = { key: "key", name: "name", description: "description", containerTypeIds: "container types" }
const SUBSCRIPTION_COLUMNS: Columns = {
  productId: "product",
  propertyId: "property",
  sharedCollectionPointId: "shared collection point",
  quantity: "quantity",
  validFrom: "subscription from",
  validTo: "subscription to",
}

/** Field errors as one sentence, each at the column its field is read from; the problem's own sentence when it names no field. */
function sentenceOf(errors: readonly { path: string; message: string }[], columns: Columns, fallback: string): string {
  if (errors.length === 0) return fallback
  return errors
    .map(({ path, message }) => {
      const column = columns[path.split(".")[0] ?? ""]
      return column === undefined ? message : `${column}: ${message}`
    })
    .join("; ")
}

/** The refusal an error is, when it is one a request could have earned; undefined for anything else, which stays the 500 it is. */
function refusalOf(error: unknown, columns: Columns): RowRefused | undefined {
  if (error instanceof RowRefused) return error
  const problem = error instanceof Refused ? refusedProblem(error) : error
  if (problem instanceof ProblemError && problem.status < 500) return new RowRefused(sentenceOf(problem.body.errors ?? [], columns, problem.body.detail ?? problem.body.title))
  return undefined
}

/** A family's write, its refusal named by the columns its body was read from. */
async function step<T>(columns: Columns, write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    throw refusalOf(error, columns) ?? error
  }
}

/** The body a schema makes of what the row gave, or the row's refusal at the columns the issues name. */
function parsed<T>(schema: z.ZodType<T>, raw: unknown, columns: Columns): T {
  const result = schema.safeParse(raw)
  if (result.success) return result.data
  throw new RowRefused(sentenceOf(result.error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message })), columns, "The row is invalid"))
}

/** A cell every row must give. */
function required(cells: Cells, header: string): string {
  const value = cells[header]
  if (value === undefined) throw refuse(header, "give it on every row")
  return value
}

/** A coded cell as the vocabulary spells it: lowercase. */
const coded = (value: string | undefined): string | undefined => value?.toLowerCase()

const YES = new Set(["yes", "y", "true", "1", "ja"])
const NO = new Set(["no", "n", "false", "0", "nej"])

/** A yes-or-no cell. */
function yesNo(cells: Cells, header: string): boolean | undefined {
  const value = coded(cells[header])
  if (value === undefined) return undefined
  if (YES.has(value)) return true
  if (NO.has(value)) return false
  throw refuse(header, "yes or no")
}

/** A day cell, checked before any statement reads it: Postgres refusing a malformed date is a 500, not a refusal. */
function day(cells: Cells, header: string): string | undefined {
  const value = cells[header]
  if (value === undefined) return undefined
  if (!IsoDate.safeParse(value).success) throw refuse(header, "a day as YYYY-MM-DD")
  return value
}

/** The largest number a whole-number column holds: the database's integer, so a pasted barcode is the row's refusal and never Postgres's 22003, which would fail the whole batch. */
const WHOLE_MAX = 2_147_483_647

/** A whole-number cell; the schema holds the rest of its range. */
function whole(cells: Cells, header: string): number | undefined {
  const value = cells[header]
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value) || Number(value) > WHOLE_MAX) throw refuse(header, `a whole number no larger than ${WHOLE_MAX}`)
  return Number(value)
}

/** The fields of `body` the row gave a cell for that differ from the record's: the patch an update writes, empty when nothing changed. */
function changes<T extends object>(current: object, body: T, given: ReadonlySet<string>): Partial<T> {
  const stored = current as Record<string, unknown>
  return Object.fromEntries(Object.entries(body).filter(([field, value]) => given.has(field) && stored[field] !== value)) as Partial<T>
}

/** The fields whose cells the row gave, by the columns they are read from. */
const givenFields = (cells: Cells, columns: Columns): Set<string> =>
  new Set(Object.entries(columns).filter(([, header]) => cells[header] !== undefined).map(([field]) => field))

const isEmpty = (patch: object): boolean => Object.keys(patch).length === 0

/** A customer named in a cell: by e-mail when it holds an @, by registration number otherwise; exactly one, or the row is refused at the column. */
async function customerNamed(context: ImportContext, header: string, key: string): Promise<string> {
  const byEmail = key.includes("@")
  const found = await customersByKey(context.tx, context.principal.companyId, byEmail ? { email: key } : { registrationNumber: key })
  if (found.length === 0) throw refuse(header, byEmail ? `No customer of this company has the e-mail ${key}` : `No customer of this company has registration number ${key}`)
  if (found.length > 1) throw refuse(header, `${found.length} customers have the e-mail ${key}: name one by its registration number`)
  return found[0]!.id
}

/** The one row of a table with this name, in its scope; the row's refusal at the column otherwise. */
async function namedId(lookup: Promise<{ id: string }[]>, header: string, missing: string): Promise<string> {
  const [row] = await lookup
  if (row === undefined) throw refuse(header, missing)
  return row.id
}

const projectOf = (context: ImportContext): string => {
  if (context.projectId === null) throw new Error("a project's kind of import ran without its project")
  return context.projectId
}

// Customers ---------------------------------------------------------------

async function importCustomer(context: ImportContext, cells: Cells): Promise<Written> {
  const { tx, principal } = context
  required(cells, "kind")
  required(cells, "name")
  const registrationNumber = cells["registration number"]
  const email = coded(cells.email)
  if (registrationNumber === undefined && email === undefined) throw refuse("registration number", "give it or the e-mail: a customer is matched on one")
  const body = parsed(
    CustomerCreate,
    {
      kind: coded(cells.kind),
      name: cells.name,
      registrationNumber,
      email,
      phone: cells.phone,
      billingAddress: cells["billing address"],
      serviceMessagesAllowed: yesNo(cells, "service messages"),
      status: coded(cells.status),
    },
    CUSTOMER_COLUMNS,
  )
  const matches = await customersByKey(tx, principal.companyId, registrationNumber !== undefined ? { registrationNumber } : { email: email! })
  if (matches.length > 1) throw refuse("email", `${matches.length} customers have the e-mail ${email}: give the registration number to say which`)
  const [current] = matches
  if (current === undefined) {
    requireAllowed(principal.grants, IMPORT_MODULES.customers, "create")
    return { outcome: "created", resourceId: (await step(CUSTOMER_COLUMNS, () => createCustomer(tx, principal, body))).id }
  }
  const patch = changes(current, body, givenFields(cells, CUSTOMER_COLUMNS))
  if (isEmpty(patch)) return { outcome: "unchanged", resourceId: current.id }
  requireAllowed(principal.grants, IMPORT_MODULES.customers, "edit")
  await step(CUSTOMER_COLUMNS, () => patchCustomer(tx, principal, current.id, parsed(CustomerPatch, patch, CUSTOMER_COLUMNS)))
  return { outcome: "updated", resourceId: current.id }
}

// Properties --------------------------------------------------------------

/** `role: customer; role: customer`, each customer named as `customerNamed` reads it. */
async function partiesNamed(context: ImportContext, text: string): Promise<PropertyParty[]> {
  const parties: PropertyParty[] = []
  for (const entry of text.split(";").map((part) => part.trim()).filter((part) => part !== "")) {
    const colon = entry.indexOf(":")
    if (colon < 0) throw refuse("parties", `"${entry}" is not role: customer`)
    const role = PropertyPartyRole.safeParse(entry.slice(0, colon).trim().toLowerCase())
    if (!role.success) throw refuse("parties", `${entry.slice(0, colon).trim()} is not a role; the roles are ${PropertyPartyRole.options.join(", ")}`)
    parties.push({ role: role.data, customerId: await customerNamed(context, "parties", entry.slice(colon + 1).trim()) })
  }
  return parties
}

const partyKey = (party: PropertyParty): string => `${party.customerId} ${party.role}`
const sameParties = (a: readonly PropertyParty[], b: readonly PropertyParty[]): boolean => {
  const keys = new Set(a.map(partyKey))
  return a.length === b.length && b.every((party) => keys.has(partyKey(party)))
}

async function importProperty(context: ImportContext, cells: Cells): Promise<Written> {
  const { tx, principal } = context
  const projectId = projectOf(context)
  const address = required(cells, "address")
  required(cells, "name")
  required(cells, "kind")
  const parties = cells.parties === undefined ? undefined : await partiesNamed(context, cells.parties)
  const body = parsed(
    PropertyCreate,
    {
      projectId,
      name: cells.name,
      address,
      registryId: cells["registry id"],
      kind: coded(cells.kind),
      notes: cells.notes,
      status: coded(cells.status),
      parties: parties ?? [],
    },
    PROPERTY_COLUMNS,
  )
  const matches = await propertiesAt(tx, principal, projectId, address)
  if (matches.length > 1) throw refuse("address", `${matches.length} properties of this project are at ${address}: correct them in Properties first`)
  const [match] = matches
  if (match === undefined) {
    requireAllowed(principal.grants, IMPORT_MODULES.properties, "create")
    return { outcome: "created", resourceId: (await step(PROPERTY_COLUMNS, () => createProperty(tx, principal, body))).id }
  }
  const current = await propertyWithParties(tx, principal.companyId, match)
  // The address is the key and the parties a set of their own; neither is a patch's.
  const given = givenFields(cells, PROPERTY_COLUMNS)
  given.delete("address")
  given.delete("parties")
  const { parties: _parties, projectId: _projectId, ...fields } = body
  const patch = changes(current, fields, given)
  const partiesMoved = parties !== undefined && !sameParties(current.parties, parties)
  if (isEmpty(patch) && !partiesMoved) return { outcome: "unchanged", resourceId: current.id }
  requireAllowed(principal.grants, IMPORT_MODULES.properties, "edit")
  if (!isEmpty(patch)) await step(PROPERTY_COLUMNS, () => patchProperty(tx, principal, current.id, parsed(PropertyPatch, patch, PROPERTY_COLUMNS)))
  if (partiesMoved) await step(PROPERTY_COLUMNS, () => setPropertyParties(tx, principal, current.id, parties))
  return { outcome: "updated", resourceId: current.id }
}

// Containers --------------------------------------------------------------

async function importContainer(context: ImportContext, cells: Cells): Promise<Written> {
  const { tx, principal } = context
  const projectId = projectOf(context)
  const label = required(cells, "label")
  const typeName = required(cells, "container type")
  const containerTypeId = await namedId(
    tx
      .select({ id: containerType.id })
      .from(containerType)
      .where(and(eq(containerType.companyId, principal.companyId), eq(containerType.name, typeName)))
      .limit(1),
    "container type",
    `No container type of this company is named ${typeName}`,
  )
  const body = parsed(
    ContainerCreate,
    {
      projectId,
      label,
      containerTypeId,
      barcode: cells.barcode,
      rfid: cells.rfid,
      serialNumber: cells["serial number"],
      ownership: coded(cells.ownership),
      notes: cells.notes,
    },
    CONTAINER_COLUMNS,
  )
  const found = await containerByLabel(tx, principal.companyId, label)
  if (found === undefined) {
    requireAllowed(principal.grants, IMPORT_MODULES.containers, "create")
    return { outcome: "created", resourceId: (await step(CONTAINER_COLUMNS, () => createContainer(tx, principal, body))).id }
  }
  // A label is the company's: one in another project is that project's container, never this file's to move.
  const row = found.projectId === projectId ? await findContainer(tx, principal, found.id) : undefined
  if (row === undefined) throw refuse("label", `This company already has a container labelled ${label}, in another project`)
  const given = givenFields(cells, CONTAINER_COLUMNS)
  given.delete("label")
  const { projectId: _projectId, ...fields } = body
  const patch = changes(containerOf(row), fields, given)
  if (isEmpty(patch)) return { outcome: "unchanged", resourceId: row.id }
  requireAllowed(principal.grants, IMPORT_MODULES.containers, "edit")
  await step(CONTAINER_COLUMNS, () => patchContainer(tx, principal, row.id, parsed(ContainerPatch, patch, CONTAINER_COLUMNS)))
  return { outcome: "updated", resourceId: row.id }
}

// Agreements and their subscriptions --------------------------------------

/** The columns that make a row's subscription; any of them without a product is a row that cannot say what it subscribes to. */
const SUBSCRIPTION_CELLS = ["property", "shared collection point", "quantity", "subscription from", "subscription to"] as const

async function projectCurrency(context: ImportContext, projectId: string): Promise<string> {
  if (context.memo.currency === undefined) {
    const [row] = await context.tx
      .select({ currency: project.currency })
      .from(project)
      .where(and(eq(project.companyId, context.principal.companyId), eq(project.id, projectId)))
      .limit(1)
    if (row === undefined) throw new Error(`project ${projectId} was checked and is not there`)
    context.memo.currency = row.currency
  }
  return context.memo.currency
}

/** The outcome of two writes in one row: made if either made, changed if either changed. */
const combined = (a: Written["outcome"], b: Written["outcome"] | undefined): Written["outcome"] =>
  a === "created" || b === "created" ? "created" : a === "updated" || b === "updated" ? "updated" : "unchanged"

async function importAgreement(context: ImportContext, cells: Cells): Promise<Written> {
  const { tx, principal } = context
  const projectId = projectOf(context)
  const number = required(cells, "number")
  const customerKey = required(cells, "customer")
  required(cells, "billing cadence")
  required(cells, "valid from")
  const validFrom = day(cells, "valid from")!
  const validTo = day(cells, "valid to")
  const customerId = await customerNamed(context, "customer", customerKey)
  const payerCustomerId = cells.payer === undefined ? customerId : await customerNamed(context, "payer", cells.payer)
  const code = cells["price list"]
  const priceListId =
    code === undefined
      ? undefined
      : await namedId(
          tx
            .select({ id: priceList.id })
            .from(priceList)
            // A code is matched case aside, as a person quotes it; one list of a code is in force at a time.
            .where(and(eq(priceList.companyId, principal.companyId), eq(priceList.projectId, projectId), sql`lower(${priceList.code}) = lower(${code})`, validOn(priceList, validFrom)))
            .limit(1),
          "price list",
          `No price list of this project is coded ${code} on ${validFrom}`,
        )
  const body = parsed(
    AgreementCreate,
    {
      projectId,
      number,
      customerId,
      payerCustomerId,
      status: coded(cells.status),
      billingCadence: coded(cells["billing cadence"]),
      currency: cells.currency?.toUpperCase() ?? (await projectCurrency(context, projectId)),
      notes: cells.notes,
      priceListId,
      validFrom,
      validTo,
    },
    AGREEMENT_COLUMNS,
  )

  // The subscription's cells, read before anything is written, so a row that cannot name its subscription writes no agreement either.
  const productName = cells.product
  if (productName === undefined) {
    const stray = SUBSCRIPTION_CELLS.find((header) => cells[header] !== undefined)
    if (stray !== undefined) throw refuse("product", `a subscription names its product: give it, or leave ${stray} empty`)
  }
  const line = productName === undefined ? undefined : await subscriptionLine(context, cells, projectId, productName, validFrom)

  let agreementOutcome: Written["outcome"]
  const current = await agreementStarting(tx, principal, projectId, number, validFrom)
  let agreementId: string
  if (current === undefined) {
    requireAllowed(principal.grants, IMPORT_MODULES.agreements, "create")
    agreementId = (await step(AGREEMENT_COLUMNS, () => createAgreement(tx, principal, body))).id
    agreementOutcome = "created"
  } else {
    agreementId = current.id
    const given = givenFields(cells, AGREEMENT_COLUMNS)
    given.delete("number")
    given.delete("validFrom")
    const { projectId: _projectId, ...fields } = body
    const patch = changes(current, fields, given)
    // A payer that was the customer moves with the customer when the payer's cell is empty, as a new agreement's payer is the customer then; one named apart stays as it stands.
    if (cells.payer === undefined && patch.customerId !== undefined && current.payerCustomerId === current.customerId) patch.payerCustomerId = patch.customerId
    agreementOutcome = isEmpty(patch) ? "unchanged" : "updated"
    if (!isEmpty(patch)) {
      requireAllowed(principal.grants, IMPORT_MODULES.agreements, "edit")
      await step(AGREEMENT_COLUMNS, () => patchAgreement(tx, principal, agreementId, parsed(AgreementPatch, patch, AGREEMENT_COLUMNS)))
    }
  }
  const lineOutcome = line === undefined ? undefined : await writeSubscription(context, agreementId, line)
  return { outcome: combined(agreementOutcome, lineOutcome), resourceId: agreementId }
}

type Line = { body: SubscriptionCreate; given: Set<string> }

/** A row's subscription as its create body: the product and the place by their keys, its first day the agreement's when empty. */
async function subscriptionLine(context: ImportContext, cells: Cells, projectId: string, productName: string, agreementFrom: string): Promise<Line> {
  const { tx, principal } = context
  const productId = await namedId(
    tx
      .select({ id: product.id })
      .from(product)
      .where(and(eq(product.companyId, principal.companyId), eq(product.projectId, projectId), eq(product.name, productName)))
      .limit(1),
    "product",
    `No product of this project is named ${productName}`,
  )
  const address = cells.property
  const pointName = cells["shared collection point"]
  if ((address === undefined) === (pointName === undefined)) throw refuse("property", "give the subscription's place: a property's address or a shared collection point's name, one of the two")
  let propertyId: string | null = null
  if (address !== undefined) {
    const places = await propertiesAt(tx, principal, projectId, address)
    if (places.length !== 1) throw refuse("property", places.length === 0 ? `No property of this project is at ${address}` : `${places.length} properties of this project are at ${address}`)
    propertyId = places[0]!.id
  }
  const sharedCollectionPointId =
    pointName === undefined
      ? null
      : await namedId(
          tx
            .select({ id: sharedCollectionPoint.id })
            .from(sharedCollectionPoint)
            .where(and(eq(sharedCollectionPoint.companyId, principal.companyId), eq(sharedCollectionPoint.projectId, projectId), eq(sharedCollectionPoint.name, pointName)))
            .limit(1),
          "shared collection point",
          `No shared collection point of this project is named ${pointName}`,
        )
  const body = parsed(
    SubscriptionCreate,
    {
      productId,
      propertyId,
      sharedCollectionPointId,
      quantity: whole(cells, "quantity"),
      validFrom: day(cells, "subscription from") ?? agreementFrom,
      validTo: day(cells, "subscription to"),
    },
    SUBSCRIPTION_COLUMNS,
  )
  // A subscription's product, place and first day are its key; its quantity and its end are what an update may change.
  const given = givenFields(cells, SUBSCRIPTION_COLUMNS)
  return { body, given: new Set([...given].filter((field) => field === "quantity" || field === "validTo")) }
}

async function writeSubscription(context: ImportContext, agreementId: string, { body, given }: Line): Promise<Written["outcome"]> {
  const { tx, principal } = context
  const current = await subscriptionStarting(tx, principal, agreementId, {
    productId: body.productId,
    propertyId: body.propertyId ?? null,
    sharedCollectionPointId: body.sharedCollectionPointId ?? null,
    validFrom: body.validFrom,
  })
  if (current === undefined) {
    requireAllowed(principal.grants, IMPORT_MODULES.agreements, "create")
    await step(SUBSCRIPTION_COLUMNS, () => createSubscription(tx, principal, agreementId, body))
    return "created"
  }
  const patch = changes(current, { quantity: body.quantity, validTo: body.validTo }, given)
  if (isEmpty(patch)) return "unchanged"
  requireAllowed(principal.grants, IMPORT_MODULES.agreements, "edit")
  await step(SUBSCRIPTION_COLUMNS, () => patchSubscription(tx, principal, current.id, parsed(SubscriptionPatch, patch, SUBSCRIPTION_COLUMNS)))
  return "updated"
}

// The catalogue (O30 of #290, row 1.18) -------------------------------------
//
// The company's, so a row names no project. A waste fraction and a vehicle
// type are matched on their key, the slug the rest of the system quotes, set
// once; a container type on its name. A vehicle type's container types are
// named by name, separated by semicolons, and replace its set when given.

async function importWasteFraction(context: ImportContext, cells: Cells): Promise<Written> {
  const { tx, principal } = context
  const key = coded(required(cells, "key"))!
  required(cells, "name")
  const body = parsed(
    WasteFractionCreate,
    { key, name: cells.name, wasteCode: cells["waste code"], treatment: coded(cells.treatment), densityKgPerCubicMetre: whole(cells, "density") },
    FRACTION_COLUMNS,
  )
  const current = await wasteFractionByKey(tx, principal.companyId, key)
  if (current === undefined) {
    requireAllowed(principal.grants, IMPORT_MODULES["waste-fractions"], "create")
    return { outcome: "created", resourceId: (await step(FRACTION_COLUMNS, () => createWasteFraction(tx, principal, body))).id }
  }
  const given = givenFields(cells, FRACTION_COLUMNS)
  given.delete("key")
  const patch = changes(current, body, given)
  if (isEmpty(patch)) return { outcome: "unchanged", resourceId: current.id }
  requireAllowed(principal.grants, IMPORT_MODULES["waste-fractions"], "edit")
  await step(FRACTION_COLUMNS, () => patchWasteFraction(tx, principal, current.id, parsed(WasteFractionPatch, patch, FRACTION_COLUMNS)))
  return { outcome: "updated", resourceId: current.id }
}

async function importContainerType(context: ImportContext, cells: Cells): Promise<Written> {
  const { tx, principal } = context
  const name = required(cells, "name")
  const body = parsed(ContainerTypeCreate, { name, volumeLitres: whole(cells, "volume"), serviceSeconds: whole(cells, "service seconds") }, CONTAINER_TYPE_COLUMNS)
  const current = await containerTypeByName(tx, principal.companyId, name)
  if (current === undefined) {
    requireAllowed(principal.grants, IMPORT_MODULES["container-types"], "create")
    return { outcome: "created", resourceId: (await step(CONTAINER_TYPE_COLUMNS, () => createContainerType(tx, principal, body))).id }
  }
  const given = givenFields(cells, CONTAINER_TYPE_COLUMNS)
  given.delete("name")
  const patch = changes(current, body, given)
  if (isEmpty(patch)) return { outcome: "unchanged", resourceId: current.id }
  requireAllowed(principal.grants, IMPORT_MODULES["container-types"], "edit")
  await step(CONTAINER_TYPE_COLUMNS, () => patchContainerType(tx, principal, current.id, parsed(ContainerTypePatch, patch, CONTAINER_TYPE_COLUMNS)))
  return { outcome: "updated", resourceId: current.id }
}

/** `240 L bin; 660 L bin`: each a container type of the company by name, once; the row's refusal at the column otherwise. */
async function containerTypesNamed(context: ImportContext, text: string): Promise<string[]> {
  const ids: string[] = []
  for (const name of text.split(";").map((part) => part.trim()).filter((part) => part !== "")) {
    const found = await containerTypeByName(context.tx, context.principal.companyId, name)
    if (found === undefined) throw refuse("container types", `No container type of this company is named ${name}`)
    if (ids.includes(found.id)) throw refuse("container types", `${name} is named twice`)
    ids.push(found.id)
  }
  return ids
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",")

async function importVehicleType(context: ImportContext, cells: Cells): Promise<Written> {
  const { tx, principal } = context
  const key = coded(required(cells, "key"))!
  required(cells, "name")
  const containerTypeIds = cells["container types"] === undefined ? undefined : await containerTypesNamed(context, cells["container types"])
  const body = parsed(VehicleTypeCreate, { key, name: cells.name, description: cells.description, containerTypeIds: containerTypeIds ?? [] }, VEHICLE_TYPE_COLUMNS)
  const current = await vehicleTypeByKey(tx, principal.companyId, key)
  if (current === undefined) {
    requireAllowed(principal.grants, IMPORT_MODULES["vehicle-types"], "create")
    return { outcome: "created", resourceId: (await step(VEHICLE_TYPE_COLUMNS, () => createVehicleType(tx, principal, body))).id }
  }
  const given = givenFields(cells, VEHICLE_TYPE_COLUMNS)
  given.delete("key")
  given.delete("containerTypeIds")
  const { containerTypeIds: _set, ...fields } = body
  const patch = changes(current, fields, given)
  const setMoved = containerTypeIds !== undefined && !sameIds(current.containerTypeIds, containerTypeIds)
  if (isEmpty(patch) && !setMoved) return { outcome: "unchanged", resourceId: current.id }
  requireAllowed(principal.grants, IMPORT_MODULES["vehicle-types"], "edit")
  if (!isEmpty(patch)) await step(VEHICLE_TYPE_COLUMNS, () => patchVehicleType(tx, principal, current.id, parsed(VehicleTypePatch, patch, VEHICLE_TYPE_COLUMNS)))
  if (setMoved) await step(VEHICLE_TYPE_COLUMNS, () => replaceVehicleTypeContainerTypes(tx, principal, current.id, containerTypeIds))
  return { outcome: "updated", resourceId: current.id }
}

// One row -----------------------------------------------------------------

const IMPORTERS: Readonly<Record<ImportKind, (context: ImportContext, cells: Cells) => Promise<Written>>> = {
  customers: importCustomer,
  properties: importProperty,
  containers: importContainer,
  agreements: importAgreement,
  "waste-fractions": importWasteFraction,
  "container-types": importContainerType,
  "vehicle-types": importVehicleType,
}

/** A row's cells as they are read: each trimmed, an empty one no cell at all, as the browser's reader sends them (@waste/domain/imports/csv) and whoever else sends a row. */
const cellsOf = (values: Cells): Cells =>
  Object.fromEntries(
    Object.entries(values)
      .map(([header, value]) => [header, value.trim()] as const)
      .filter(([, value]) => value !== ""),
  )

/** What a row was matched on, as a person reads it; null when the row lacks its key. */
export function keyOf(kind: ImportKind, cells: Cells): string | null {
  switch (kind) {
    case "customers":
      return cells["registration number"] !== undefined ? `registration number ${cells["registration number"]}` : cells.email !== undefined ? `email ${cells.email.toLowerCase()}` : null
    case "properties":
      return cells.address === undefined ? null : `address ${cells.address}`
    case "containers":
      return cells.label === undefined ? null : `label ${cells.label}`
    case "agreements": {
      if (cells.number === undefined || cells["valid from"] === undefined) return null
      const agreementKey = `number ${cells.number} from ${cells["valid from"]}`
      if (cells.product === undefined) return agreementKey
      const place = cells.property ?? cells["shared collection point"]
      const from = cells["subscription from"]
      return `${agreementKey}, ${cells.product}${place === undefined ? "" : ` at ${place}`}${from === undefined || from === cells["valid from"] ? "" : ` from ${from}`}`
    }
    case "waste-fractions":
    case "vehicle-types":
      return cells.key === undefined ? null : `key ${cells.key.toLowerCase()}`
    case "container-types":
      return cells.name === undefined ? null : `name ${cells.name}`
  }
}

/**
 * One row, inside its own savepoint of `context.tx`: its outcome, or its
 * refusal with the savepoint rolled back. An error no request could have
 * earned is not a refusal and is thrown, so the whole request fails as the
 * 500 it is rather than reading as one row's problem.
 */
export async function importRow(context: ImportContext, kind: ImportKind, row: ImportRowValues): Promise<ImportRowResult> {
  const cells = cellsOf(row.values)
  const key = keyOf(kind, cells)
  try {
    const written = await context.tx.transaction((savepoint) => IMPORTERS[kind]({ ...context, tx: savepoint }, cells))
    return { row: row.row, outcome: written.outcome, key, resourceId: written.resourceId, detail: null }
  } catch (error) {
    const refusal = refusalOf(error, {})
    if (refusal === undefined) throw error
    return { row: row.row, outcome: "refused", key, resourceId: null, detail: refusal.message }
  }
}
