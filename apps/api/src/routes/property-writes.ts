// A Property's writes (Issue #78), the one spelling `POST /properties`,
// `PATCH /properties/:id`, `PUT /properties/:id/parties` and the CSV import
// (#291 slice 12) all run: the project held to the caller's, the parties each
// a customer of this company, a name one property's inside its project and a
// registry identifier one property's inside the company, in the routes' own
// sentences. Each takes the request's transaction, or a savepoint of it, and
// the caller; the grant is the caller's to have checked. `propertiesAt` is
// the key a person knows a property by in a file, its address in a project.
//
// A body may name the address register's `addressId` (#291 C13): the route
// read the address before its transaction opened (routes/addresses.ts) and
// hands it here, and the property stores the register's designation as its
// address with the parts and the id beside it, and the register's BFE number
// and point where the body sets neither. An id the register does not hold is
// a 400 on `addressId`. A typed address is no longer the register's, so a
// patch of `address` alone lets the id and the parts go.
import type { Address } from "@waste/contracts/addresses"
import type { AddressParts } from "@waste/domain/registry/address"
import type { Property, PropertyCreate, PropertyKind, PropertyParty, PropertyPartyRole, PropertyPatch, PropertyStatus } from "@waste/contracts/customers"
import type { FlatPoint } from "@waste/contracts/geojson"
import type { Tx } from "@waste/db/client"
import { property, propertyParty } from "@waste/db/schema/customers"
import { and, asc, eq, sql, type SQL, type SQLWrapper } from "drizzle-orm"

import type { Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { newId } from "../ids"
import { invalidRequest, problem } from "../problem"
import { entriesFor, replaceSet, requirePartyCustomers, writeEntries, type Entry, type MemberSet, type Parent } from "./members"
import { refuseDuplicate, stampsOf } from "./shared"
import { serviceWindowOf, serviceWindowValues } from "./time-windows"

export const propertyColumns = {
  id: property.id,
  projectId: property.projectId,
  name: property.name,
  address: property.address,
  addressId: property.addressId,
  streetName: property.streetName,
  houseNumber: property.houseNumber,
  floor: property.floor,
  door: property.door,
  postcode: property.postcode,
  postTown: property.postTown,
  municipalityCode: property.municipalityCode,
  registryId: property.registryId,
  kind: property.kind,
  location: property.location,
  notes: property.notes,
  driverInstructions: property.driverInstructions,
  serviceWindowStart: property.serviceWindowStart,
  serviceWindowEnd: property.serviceWindowEnd,
  status: property.status,
  createdAt: property.createdAt,
  updatedAt: property.updatedAt,
}

export type PropertyRow = Pick<typeof property.$inferSelect, keyof typeof propertyColumns>

/** The parties of a Property: a Customer of this company, and what it is to the property. */
export const parties: MemberSet<typeof propertyParty> = {
  table: propertyParty,
  parentId: propertyParty.propertyId,
  entryId: propertyParty.customerId,
  rowOf: (entry, parent) => ({
    id: newId(),
    companyId: parent.companyId,
    projectId: parent.projectId,
    propertyId: parent.id,
    customerId: entry.id,
    role: entry.role,
  }),
  require: requirePartyCustomers,
}

/** The two spellings of one party: the wire's, and the set mechanics' (routes/members.ts). */
const partyOf = (entry: Entry): PropertyParty => ({ customerId: entry.id, role: entry.role as PropertyPartyRole })
export const entryOf = (party: PropertyParty): Entry => ({ id: party.customerId, role: party.role })

/** The row on the wire, with the parties the page loaded for it. `kind` and `status` are text with a CHECK in the database and an enum here; the point is the contracts' `FlatPoint`, since the column is `geometry(Point, 4326)`, flat, and refuses a third ordinate on write, however the column's type spells the altitude as optional. */
export function propertyOf(row: PropertyRow, held: readonly Entry[]): Property {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    address: row.address,
    addressId: row.addressId,
    addressParts: partsOf(row),
    registryId: row.registryId,
    kind: row.kind as PropertyKind,
    location: row.location as FlatPoint | null,
    notes: row.notes,
    driverInstructions: row.driverInstructions,
    serviceWindow: serviceWindowOf(row),
    status: row.status as PropertyStatus,
    parties: held.map(partyOf),
    ...stampsOf(row),
  }
}

/** The register's parts of a row, null for a typed address; the database's `property_address_shape` holds them all present with the id. */
function partsOf(row: PropertyRow): AddressParts | null {
  if (row.addressId === null || row.streetName === null || row.houseNumber === null || row.postcode === null || row.postTown === null || row.municipalityCode === null) return null
  return { streetName: row.streetName, houseNumber: row.houseNumber, floor: row.floor, door: row.door, postcode: row.postcode, postTown: row.postTown, municipalityCode: row.municipalityCode }
}

/** The columns of a register's address, or of none: what a typed address clears. */
const addressColumns = (found: Address | null) => ({
  addressId: found?.id ?? null,
  streetName: found?.parts.streetName ?? null,
  houseNumber: found?.parts.houseNumber ?? null,
  floor: found?.parts.floor ?? null,
  door: found?.parts.door ?? null,
  postcode: found?.parts.postcode ?? null,
  postTown: found?.parts.postTown ?? null,
  municipalityCode: found?.parts.municipalityCode ?? null,
})

/**
 * What a body's `addressId` writes, given what the register said of it: the
 * register's designation and parts, and its BFE number and point where the
 * body sets neither. Nothing where the body names no id; a 400 on
 * `addressId` where the register holds none by it.
 */
type RegisterValues = Partial<ReturnType<typeof addressColumns> & { address: string; registryId: string | null; location: FlatPoint | null }>

function registerValues(body: { addressId?: string | null; registryId?: string | null; location?: unknown }, found: Address | null | undefined): RegisterValues {
  if (body.addressId == null) return {}
  if (found == null || found.id !== body.addressId) {
    throw invalidRequest("body", [{ path: "addressId", message: `No address ${body.addressId} in the address register` }])
  }
  return {
    address: found.designation,
    ...addressColumns(found),
    ...(body.registryId === undefined ? { registryId: found.registryId } : {}),
    ...(body.location === undefined ? { location: found.location } : {}),
  }
}

/** One property on the wire, its parties read back the way a page reads them, so an answer equals the next read. */
export async function propertyWithParties(tx: Tx, companyId: string, row: PropertyRow): Promise<Property> {
  return propertyOf(row, await entriesFor(tx, parties, companyId, row.id))
}

/** `unique (company_id, project_id, name)`: a name is one property's inside a project, and free in the next. */
const NAME_TAKEN = "property_project_id_name_key"
const nameTaken = (name: string) => `This project already has a property called ${JSON.stringify(name)}`

/** The partial unique index `(company_id, registry_id) where registry_id is not null`, which Postgres names as the constraint it refused with. */
const REGISTRY_TAKEN = "property_registry_id_idx"
const registryTaken = (registryId: string) => `This company already has a property with the registry identifier ${registryId}`

/** The sentences a write here can earn, and only for the fields the body gave. */
const collisions = (values: { name?: string; registryId?: string | null }): Record<string, string> => ({
  ...(values.name === undefined ? {} : { [NAME_TAKEN]: nameTaken(values.name) }),
  ...(values.registryId == null ? {} : { [REGISTRY_TAKEN]: registryTaken(values.registryId) }),
})

export const noSuchProperty = (id: string) => problem(404, { detail: `No property ${id} in the projects this account works in` })

/** The rows of this company, in the projects the caller works in: what every property statement is bounded by. */
export const propertyScope = (principal: Principal) => and(eq(property.companyId, principal.companyId), inProjects(property.projectId, principal))

/** One property of this company by id, inside the caller's projects; undefined when it is neither. */
export async function findProperty(tx: Tx, principal: Principal, id: string): Promise<PropertyRow | undefined> {
  const [row] = await tx
    .select(propertyColumns)
    .from(property)
    .where(and(propertyScope(principal), eq(property.id, id)))
    .limit(1)
  return row
}

/** Registers a property in one of the caller's projects, with the parties it starts with; `found` is what the register said of the body's `addressId`. */
export async function createProperty(tx: Tx, principal: Principal, body: PropertyCreate, found?: Address | null): Promise<Property> {
  const { parties: asked, serviceWindow, addressId: _named, ...given } = body
  requireProject(principal, given.projectId)
  const fromRegister = registerValues(body, found)
  const address = fromRegister.address ?? given.address
  // The contract holds a create to one address, typed or the register's; this is its type's word for it.
  if (address === undefined) throw invalidRequest("body", [{ path: "address", message: "Give the address, typed or as the address register's addressId" }])
  const values = { ...given, ...fromRegister, address }
  const parent: Parent = { companyId: principal.companyId, projectId: values.projectId, id: newId() }
  const entries = asked.map(entryOf)
  await parties.require(tx, parent, entries)
  const [row] = await refuseDuplicate(collisions(values), () =>
    tx
      .insert(property)
      .values({ ...values, ...serviceWindowValues(serviceWindow), id: parent.id, companyId: parent.companyId })
      .returning(propertyColumns),
  )
  await writeEntries(tx, parties, parent, entries)
  return await propertyWithParties(tx, parent.companyId, row)
}

/** Changes one property of the caller's projects; a 404 for one they do not reach. `found` is what the register said of the body's `addressId`. */
export async function patchProperty(tx: Tx, principal: Principal, id: string, body: PropertyPatch, found?: Address | null): Promise<Property> {
  const { serviceWindow, addressId, ...given } = body
  // The path's row first (404), then the body's id (400), as a route judges them.
  if (addressId != null && (await findProperty(tx, principal, id)) === undefined) throw noSuchProperty(id)
  const patch = {
    ...given,
    // A typed address, or an id let go, is no longer the register's; an id named is the register's whole.
    ...(given.address !== undefined || addressId === null ? addressColumns(null) : {}),
    ...registerValues(body, found),
  }
  const [row] = await refuseDuplicate(collisions(patch), () =>
    tx
      .update(property)
      .set({ ...patch, ...serviceWindowValues(serviceWindow) })
      .where(and(propertyScope(principal), eq(property.id, id)))
      .returning(propertyColumns),
  )
  if (row === undefined) throw noSuchProperty(id)
  return await propertyWithParties(tx, principal.companyId, row)
}

/** Replaces a property's parties whole; a 404 for a property the caller does not reach. */
export async function setPropertyParties(tx: Tx, principal: Principal, id: string, asked: readonly PropertyParty[]): Promise<Property> {
  const row = await replaceSet(tx, parties, principal.companyId, asked.map(entryOf), (stamped) =>
    tx
      .update(property)
      .set(stamped)
      .where(and(propertyScope(principal), eq(property.id, id)))
      .returning(propertyColumns),
  )
  if (row === undefined) throw noSuchProperty(id)
  return await propertyWithParties(tx, principal.companyId, row)
}

/** The properties of one of the caller's projects at an address, compared as a person reads it: case and spacing aside. In creation order, without their parties, which `propertyWithParties` reads for the one a caller settles on. */
export async function propertiesAt(tx: Tx, principal: Principal, projectId: string, address: string): Promise<PropertyRow[]> {
  return await tx
    .select(propertyColumns)
    .from(property)
    .where(and(propertyScope(principal), eq(property.projectId, projectId), sql`${addressKey(property.address)} = ${addressKey(address)}`))
    .orderBy(asc(property.id))
}

/** An address as it is compared — trimmed, lowercase, its runs of white space one space — spelled in SQL for the column and the value alike, so one `lower` reads both whatever the database's locale makes of a letter. */
const addressKey = (address: string | SQLWrapper): SQL => sql`lower(regexp_replace(trim(${address}::text), '\\s+', ' ', 'g'))`
